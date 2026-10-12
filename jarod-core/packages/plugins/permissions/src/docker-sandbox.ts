// Portage de packages/core/src/services/docker-sandbox.ts (rév. 2e180305).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type DockerOptions, DEFAULT_DOCKER } from "@jarod/contracts";
export { DEFAULT_DOCKER };
export type { DockerOptions };

/**
 * Docker as an execution environment: `run_shell` runs inside a container that shares nothing with
 * the machine but the workspace (bind-mounted at /workspace). Writing anywhere else only touches
 * the container's own disposable filesystem — the host is out of reach, on Windows as elsewhere,
 * which the local shell cannot promise there without native code.
 *
 * One long-lived container per workspace, so what a command installs is still there for the next
 * one (like a terminal left open), recreated when its options change. No privilege escalation
 * (`no-new-privileges`), a process cap, optional memory/CPU limits and network cut-off. Secrets are
 * passed as `-e NAME` without a value: docker reads it from its own environment, so a value never
 * appears on a command line that other processes could list.
 */

// DockerOptions : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// DEFAULT_DOCKER : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

export type DockerExec = (
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** The docker CLI, without a shell. */
export const dockerCli: DockerExec = (args, timeoutMs = 120_000) =>
  new Promise((done) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : null
          : 0;
        done({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
      },
    );
  });

const real = (p: string) => {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return resolve(p);
  }
};

/** A stable, readable container name per workspace (case-insensitive on Windows). */
export function containerName(workspace: string): string {
  const key = process.platform === "win32" ? real(workspace).toLowerCase() : real(workspace);
  return `jarod-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** What the container was created with: a change means it must be recreated. */
export function optionsHash(workspace: string, o: DockerOptions): string {
  return createHash("sha256")
    .update(JSON.stringify([real(workspace), o.image, o.network, o.memory, o.cpus]))
    .digest("hex")
    .slice(0, 16);
}

export function runArgs(name: string, workspace: string, o: DockerOptions): string[] {
  return [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `jarod.options=${optionsHash(workspace, o)}`,
    "--mount",
    `type=bind,source=${real(workspace)},target=/workspace`,
    "-w",
    "/workspace",
    "--pids-limit",
    "1024",
    "--security-opt",
    "no-new-privileges",
    ...(o.network ? [] : ["--network", "none"]),
    ...(o.memory ? ["--memory", o.memory] : []),
    ...(o.cpus > 0 ? ["--cpus", String(o.cpus)] : []),
    // Kept alive by a shell loop: works with any image, whatever its entrypoint.
    "--entrypoint",
    "sh",
    o.image,
    "-c",
    "trap 'exit 0' TERM; while :; do sleep 3600 & wait $!; done",
  ];
}

/** The folder inside the container matching `cwd` on the host (always under /workspace). */
export function containerPath(workspace: string, cwd: string): string {
  const rel = relative(real(workspace), real(cwd));
  if (rel.startsWith("..") || isAbsolute(rel)) return "/workspace";
  return rel ? `/workspace/${rel.split(sep).join("/")}` : "/workspace";
}

export function execArgs(name: string, containerCwd: string, envKeys: string[], command: string): string[] {
  return ["exec", "-i", "-w", containerCwd, ...envKeys.flatMap((k) => ["-e", k]), name, "sh", "-c", command];
}

export class DockerSandbox {
  constructor(private readonly exec: DockerExec = dockerCli) {}

  /** Whether the docker CLI answers and its daemon runs — checked, never assumed. */
  async available(): Promise<{ ok: boolean; detail: string }> {
    const r = await this.exec(["version", "--format", "{{.Server.Version}}"], 15_000);
    if (r.code === 0 && r.stdout.trim()) return { ok: true, detail: `Docker ${r.stdout.trim()}` };
    const why = (r.stderr || r.stdout).trim().split("\n")[0] || "docker introuvable";
    return { ok: false, detail: `Docker ne répond pas : ${why}` };
  }

  /** The workspace's container, running with these options: reused, restarted or (re)created. */
  async ensure(workspace: string, o: DockerOptions): Promise<string> {
    const name = containerName(workspace);
    const want = optionsHash(workspace, o);
    const inspect = await this.exec(
      ["inspect", "-f", '{{.State.Running}} {{index .Config.Labels "jarod.options"}}', name],
      30_000,
    );
    if (inspect.code === 0) {
      const [running, has] = inspect.stdout.trim().split(/\s+/);
      if (has === want) {
        if (running === "true") return name;
        const started = await this.exec(["start", name], 60_000);
        if (started.code === 0) return name;
      }
      await this.exec(["rm", "-f", name], 60_000);
    }
    // First creation may pull the image: minutes, not seconds.
    const created = await this.exec(runArgs(name, workspace, o), 15 * 60_000);
    if (created.code !== 0) {
      throw new Error(
        `Conteneur impossible à créer (${o.image}) : ${(created.stderr || created.stdout).trim().slice(0, 400)}`,
      );
    }
    return name;
  }

  /** Removes the workspace's container (what was installed in it goes with it). */
  async remove(workspace: string): Promise<boolean> {
    return (await this.exec(["rm", "-f", containerName(workspace)], 60_000)).code === 0;
  }
}
