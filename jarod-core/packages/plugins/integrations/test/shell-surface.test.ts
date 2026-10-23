// V-12 — le registre unique : la surface du shell (matrice C2, la même que le shell TS applique et que l'hôte Rust lit), le registre de la
// fenêtre lu par la porte du cœur, et l'hôte Rust — dans le même CapabilityService, avec leur état mesuré.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capabilitiesTool, CapabilityService } from "../src/cockpit/index.js";
import type { ProbeHost } from "../src/cockpit/probe.js";
import { rustCapabilities, SHELL_CLI, SHELL_MATRIX, type ShellDoor, shellDoor } from "../src/cockpit/shell-surface.js";

const MATRIX = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "contracts", "v1", "fixtures", "c2-authorization-matrix", "valid-current.json"), "utf8"));

const made: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const s of servers.splice(0)) s.close();
});

const host = (env: Record<string, string | undefined> = {}, files: string[] = []): ProbeHost => ({
  platform: "win32",
  env,
  exists: (p) => files.includes(p),
  readText: () => null,
  run: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }) as never,
});

const service = (shell?: ShellDoor, env: Record<string, string | undefined> = {}, files: string[] = []) =>
  new CapabilityService({ host: host(env, files), tools: { info: () => [], spec: () => undefined }, skills: () => [], mcpServers: () => [], decide: () => "allow", ...(shell ? { shell } : {}) });

/** Une porte de contrôle comme celle du shell : lignes JSON, jeton exigé ; `state` et `ui-list`. */
async function fakeDoor(token: string, behaviour: "ok" | "refuse" = "ok"): Promise<{ env: NodeJS.ProcessEnv; seen: Record<string, unknown>[] }> {
  const seen: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      seen.push(request);
      const reply =
        behaviour === "refuse" || request.token !== token
          ? { ok: false, error: "unauthorized" }
          : request.cmd === "ui-list"
            ? { ok: true, result: [{ id: "page.open", title: "Ouvrir une page", tier: "act", args: [{ name: "page", description: "la page", required: true }] }, { id: "memory.forget", title: "Oublier un souvenir", tier: "destructive", args: [], hidden: true }] }
            : { ok: true, result: { pages: [] } };
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { env: { JAROD_OS_CONTROL_SOCKET: `tcp://127.0.0.1:${(server.address() as { port: number }).port}`, JAROD_OS_CONTROL_TOKEN: token }, seen };
}

describe("V-12 — la surface du shell vient de la matrice C2, sans recopie", () => {
  it("une capacité par commande de la matrice ; palier par action = le plus fort ; la porte du cœur dite", async () => {
    expect(SHELL_MATRIX.commands.map((c) => c.name)).toEqual(MATRIX.shellCommands.map((c: { name: string }) => c.name));
    const tier = (name: string) => SHELL_MATRIX.commands.find((c) => c.name === name)!.tier;
    expect(tier("state")).toBe("read");
    expect(tier("plugin")).toBe("destructive");
    expect(tier("branding")).toBe("mutate");
    const rows = await service().list();
    const page = rows.find((r) => r.id === "shell.page")!;
    expect(page).toMatchObject({ integration: "shell-command", risk: "act", limits: expect.arrayContaining(["porte du cœur : oui"]) });
    expect(rows.find((r) => r.id === "shell.wallpaper")!.limits).toEqual(expect.arrayContaining([`porte du cœur : non (la CLI ${SHELL_CLI} seulement)`, "exige un accord vu par le shell (capacité à usage unique)"]));
  });
});

describe("V-12 — la porte de contrôle, interrogée pour de vrai", () => {
  it("porte ouverte : la surface est « disponible », et le registre de la fenêtre entre au registre avec son schéma d'entrée", async () => {
    const { env, seen } = await fakeDoor("jeton-de-test");
    const rows = await service(shellDoor(env)).list();
    expect(rows.find((r) => r.id === "shell.state")).toMatchObject({ state: "available", detail: expect.stringMatching(/ouverte/) });
    expect(rows.find((r) => r.id === "ui.page.open")).toMatchObject({ state: "available", name: "Ouvrir une page", risk: "act", input: { properties: { page: { type: "string" } }, required: ["page"] } });
    expect(rows.find((r) => r.id === "ui.memory.forget")).toMatchObject({ risk: "destructive", limits: expect.arrayContaining(["cachée de la palette"]) });
    // Le jeton part avec chaque requête, et la source se dit « agent ».
    expect(seen.every((r) => r.token === "jeton-de-test" && r.source === "agent")).toBe(true);
    expect(seen.map((r) => r.cmd).sort()).toEqual(["state", "ui-list"]);
  });

  it("sans shell : la surface le dit, aucune commande de fenêtre n'est inventée ; refusée : la raison", async () => {
    const alone = await service(shellDoor({})).list();
    expect(alone.find((r) => r.id === "shell.state")).toMatchObject({ state: "installed-unconfigured", detail: expect.stringMatching(/ne tourne pas sous le shell/) });
    expect(alone.some((r) => r.id.startsWith("ui."))).toBe(false);

    const { env } = await fakeDoor("bon", "refuse");
    const refused = await service(shellDoor(env)).list();
    expect(refused.find((r) => r.id === "shell.state")!.detail).toMatch(/a refusé : unauthorized/);
  });

  it("l'outil capabilities reste compact : une ligne par famille, le détail par describe", async () => {
    const { env } = await fakeDoor("j");
    const tool = capabilitiesTool(service(shellDoor(env)));
    const out = await tool.run({ action: "list" }, { sessionId: "s", workspace: null });
    expect(out).toMatch(/^shell : 29 commandes du canal de contrôle — porte de contrôle du shell ouverte/m);
    expect(out).toMatch(/^fenêtre : 2 commandes de son registre/m);
    expect(out).toMatch(/^hôte Rust : /m);
    expect(out.split("\n").length).toBeLessThan(40);
    expect(await tool.run({ action: "describe", id: "ui.page.open" }, { sessionId: "s", workspace: null })).toMatch(/Ouvrir une page/);
  });
});

describe.runIf(process.platform === "win32")("V-12 — la porte annoncée en tube nommé Windows (pipe://<nom>)", () => {
  it("le cœur joint le tube nommé que le shell annonce : la surface est disponible", async () => {
    const name = `jarod-v12-${process.pid}-${Date.now()}`;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", () => socket.end(`${JSON.stringify({ ok: true, result: {} })}\n`));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(`\\\\.\\pipe\\${name}`, () => r()));
    const state = await shellDoor({ JAROD_OS_CONTROL_SOCKET: `pipe://${name}`, JAROD_OS_CONTROL_TOKEN: "t" }).state();
    expect(state).toEqual({ ok: true, detail: expect.stringMatching(/ouverte/) });
  });
});

describe("V-12 — l'hôte Rust au registre, sans présenter un prototype comme branché", () => {
  it("le bac à sable est disponible quand son binaire est là (variable ou PATH) ; les autres crates sont des prototypes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-v12-"));
    made.push(dir);
    const bin = join(dir, "jarod-sandbox.exe");
    writeFileSync(bin, "");
    const withBin = await service(undefined, { JAROD_SANDBOX_BIN: bin }, [bin]).check("rust.host-sandbox");
    expect(withBin).toMatchObject({ state: "available", found: [bin] });
    expect((await service().check("rust.host-sandbox")).state).toBe("not-installed");
    const control = await service().check("rust.host-control");
    expect(control).toMatchObject({ state: "installed-unconfigured", integration: "infrastructure", detail: expect.stringMatching(/pas encore branchée/) });
    expect(rustCapabilities().map((r) => r.id)).toEqual(["rust.host-sandbox", "rust.host-control", "rust.host-updater", "rust.host-supervisor", "rust.host-storage", "rust.host-vault"]);
  });
});
