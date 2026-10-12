// Portage de packages/core/test/docker-sandbox.test.ts (rév. 2e180305).
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  containerName,
  containerPath,
  DEFAULT_DOCKER,
  type DockerExec,
  DockerSandbox,
  execArgs,
  optionsHash,
  runArgs,
} from "../src/docker-sandbox.js";
import {
  ShellGuardService,
  type ShellPlanResult,
  type ShellProbe,
  seatbeltProfile,
} from "../src/shell-guard.js";
import { tempDir } from "./helpers.js";

/** A fake docker CLI: records calls, answers from a small in-memory state. */
function fakeDocker(state: { daemon?: boolean; container?: { running: boolean; hash: string } | null } = {}) {
  const calls: string[][] = [];
  let container = state.container ?? null;
  const exec: DockerExec = async (args) => {
    calls.push(args);
    const [cmd] = args;
    if (cmd === "version") {
      return state.daemon === false
        ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
        : { code: 0, stdout: "27.3.1\n", stderr: "" };
    }
    if (cmd === "inspect") {
      return container
        ? { code: 0, stdout: `${container.running} ${container.hash}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "No such object" };
    }
    if (cmd === "start" && container) {
      container.running = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "rm") {
      container = null;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "run") {
      const label = args[args.indexOf("--label") + 1]!;
      container = { running: true, hash: label.split("=")[1]! };
      return { code: 0, stdout: "abc123\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "inattendu" };
  };
  return { exec, calls, sandbox: new DockerSandbox(exec) };
}

const plan = (r: ShellPlanResult) => {
  if (r.kind !== "plan") throw new Error(`refus inattendu : ${r.reason}`);
  return r;
};

describe("le conteneur d'un dossier de travail", () => {
  it("a un nom stable par dossier et ne partage que ce dossier", () => {
    const a = tempDir();
    const b = tempDir();
    expect(containerName(a)).toBe(containerName(a));
    expect(containerName(a)).not.toBe(containerName(b));
    expect(containerName(a)).toMatch(/^jarod-[0-9a-f]{12}$/);

    const args = runArgs("jarod-x", a, { ...DEFAULT_DOCKER, network: false, memory: "2g", cpus: 1 });
    expect(args).toContain(`type=bind,source=${realpathSync.native(a)},target=/workspace`);
    expect(args.join(" ")).toContain("--security-opt no-new-privileges");
    expect(args.join(" ")).toContain("--network none");
    expect(args.join(" ")).toContain("--memory 2g");
    expect(args.filter((x) => x.startsWith("type=bind"))).toHaveLength(1);
  });

  it("place la commande dans le bon dossier du conteneur, et ne met jamais une valeur sur la ligne", () => {
    const ws = tempDir();
    expect(containerPath(ws, ws)).toBe("/workspace");
    expect(containerPath(ws, join(ws, "src", "lib"))).toBe("/workspace/src/lib");
    expect(containerPath(ws, tempDir())).toBe("/workspace");
    expect(execArgs("jarod-x", "/workspace/src", ["GH_TOKEN"], "npm test")).toEqual([
      "exec",
      "-i",
      "-w",
      "/workspace/src",
      "-e",
      "GH_TOKEN",
      "jarod-x",
      "sh",
      "-c",
      "npm test",
    ]);
  });

  it("réutilise le conteneur, le redémarre, ou le recrée quand ses options changent", async () => {
    const ws = tempDir();
    const hash = optionsHash(ws, DEFAULT_DOCKER);

    const fresh = fakeDocker();
    await fresh.sandbox.ensure(ws, DEFAULT_DOCKER);
    expect(fresh.calls.map((c) => c[0])).toEqual(["inspect", "run"]);

    const running = fakeDocker({ container: { running: true, hash } });
    await running.sandbox.ensure(ws, DEFAULT_DOCKER);
    expect(running.calls.map((c) => c[0])).toEqual(["inspect"]);

    const stopped = fakeDocker({ container: { running: false, hash } });
    await stopped.sandbox.ensure(ws, DEFAULT_DOCKER);
    expect(stopped.calls.map((c) => c[0])).toEqual(["inspect", "start"]);

    const changed = fakeDocker({ container: { running: true, hash } });
    await changed.sandbox.ensure(ws, { ...DEFAULT_DOCKER, image: "python:3.13" });
    expect(changed.calls.map((c) => c[0])).toEqual(["inspect", "rm", "run"]);
    expect(changed.calls.at(-1)).toContain("python:3.13");
  });
});

describe("le garde du shell avec Docker", () => {
  it("tient le confinement des écritures sous Windows, là où la machine seule ne le peut pas", async () => {
    const ws = tempDir();
    const local = new ShellGuardService({ workspace: ws, policy: { writeScope: "workspace" }, platform: "win32" });
    expect((await local.plan("echo x", { cwd: ws })).kind).toBe("refuse");

    const { sandbox } = fakeDocker();
    const guard = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace", environment: "docker" },
      platform: "win32",
      docker: sandbox,
    });
    const p = plan(await guard.plan("npm test", { cwd: join(ws), envKeys: ["GH_TOKEN"] }));
    expect(p.mechanism).toBe("docker");
    expect(p.mode).toBe("exec");
    expect(p.args.slice(0, 6)).toEqual(["exec", "-i", "-w", "/workspace", "-e", "GH_TOKEN"]);
    expect(p.args.slice(-3)).toEqual(["sh", "-c", "npm test"]);
    expect(p.detail).toMatch(/seul .* est partagé/);
  });

  it("refuse quand le démon ne répond pas, ou hors du dossier partagé, sans rien lancer", async () => {
    const ws = tempDir();
    const down = fakeDocker({ daemon: false });
    const guard = new ShellGuardService({ workspace: ws, policy: { environment: "docker" }, docker: down.sandbox });
    const r = await guard.plan("ls", { cwd: ws });
    expect(r.kind === "refuse" && r.reason).toMatch(/Docker ne répond pas/);
    expect(down.calls.map((c) => c[0])).toEqual(["version"]);

    const up = fakeDocker();
    const outside = new ShellGuardService({ workspace: ws, policy: { environment: "docker" }, docker: up.sandbox });
    expect((await outside.plan("ls", { cwd: tempDir() })).kind).toBe("refuse");
    expect(up.calls).toEqual([]);
  });

  it("dans un conteneur, la liste des programmes se juge sur le nom (le binaire est celui de l'image)", async () => {
    const ws = tempDir();
    const { sandbox } = fakeDocker();
    const guard = new ShellGuardService({
      workspace: ws,
      policy: { environment: "docker", allowedPrograms: ["cargo"] },
      docker: sandbox,
    });
    expect((await guard.plan("cargo build", { cwd: ws })).kind).toBe("plan");
    expect((await guard.plan("rm -rf /", { cwd: ws })).kind).toBe("refuse");
  });
});

describe("Seatbelt sous macOS", () => {
  const present: ShellProbe = (input, platform) =>
    input.platforms.includes(platform)
      ? { ok: true, path: `/usr/bin/${input.binary}`, detail: "simulé" }
      : { ok: false, path: null, detail: "absent" };

  it("refuse l'écriture partout sauf dans le dossier de travail et les temporaires", async () => {
    const ws = tempDir();
    const guard = new ShellGuardService({
      workspace: ws,
      policy: { writeScope: "workspace" },
      platform: "darwin",
      probe: present,
    });
    const p = plan(await guard.plan("make", { cwd: ws }));
    expect(p.mechanism).toBe("sandbox-exec");
    expect(p.bin).toBe("/usr/bin/sandbox-exec");
    expect(p.args[0]).toBe("-p");
    expect(p.args[1]).toContain("(deny file-write*)");
    expect(p.args[1]).toContain(`(subpath "${realpathSync.native(ws).replace(/\\/g, "\\\\")}")`);
    expect(p.args.slice(-3)).toEqual(["/bin/sh", "-c", "make"]);
    expect(seatbeltProfile(['/a "b"'])).toContain('(subpath "/a \\"b\\"")');
  });
});
