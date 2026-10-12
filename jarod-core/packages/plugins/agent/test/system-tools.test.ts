// Outils système (phase 1, lecture seule) dans la boucle réelle de l'agent : le vrai noyau, un faux modèle qui les appelle, le journal d'audit.
// Barre du plan (jarod-herald-reuse.md § 6, phase 1, critère 3) : chaque appel laisse une ligne lisible, y compris pour un outil non dangereux.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatRequest } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

async function core(toolName: string, args: Record<string, unknown>, rules: { tool: string; decision: "allow" | "ask" | "deny" }[] = []) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  plugins.permissions = { rules };
  const app = await bootApp(plugins);
  const c = app.agent;
  c.settings.set("autoTitle", false);
  c.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.some((m) => m.role === "tool")
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: [{ id: "t1", name: toolName, args }], stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  return c;
}

const win = process.platform === "win32";
const lastTool = (c: Awaited<ReturnType<typeof core>>, id: string) => c.messages.list(id).filter((m) => m.role === "tool").at(-1);

describe.runIf(win)("outils système dans la boucle de l'agent", () => {
  it("system_info : sans accord demandé, un résultat réel, une ligne d'audit lisible", async () => {
    const c = await core("system_info", {});
    const asked: string[] = [];
    const s = c.sessions.create();
    await c.runAndWait(s.id, "quelle machine ?", { emit: () => {}, approve: async (_s, call) => (asked.push(call.name), true) });
    expect(asked).toEqual([]);
    const result = lastTool(c, s.id)!;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toMatchObject({ os: expect.stringMatching(/Windows/) });
    expect(c.auditLog()).toEqual([expect.objectContaining({ tool: "system_info", decision: "automatique", ok: true, args: "{}" })]);
  }, 60_000);

  it("un appel qui échoue est audité avec ok:false et l'erreur est rendue au modèle", async () => {
    const c = await core("system_processes", { action: "port" });
    const s = c.sessions.create();
    await c.runAndWait(s.id, "quel port ?", { emit: () => {}, approve: async () => true });
    expect(lastTool(c, s.id)).toMatchObject({ isError: true, content: expect.stringMatching(/port est requis/) });
    expect(c.auditLog()).toEqual([expect.objectContaining({ tool: "system_processes", decision: "automatique", ok: false })]);
  }, 60_000);

  it("le mode Plan les laisse tourner (lecture seule) ; une règle deny sur « system » les bloque tous et l'audite", async () => {
    const plan = await core("system_disk_usage", { path: tempDir(), limit: 1, depth: 1 });
    plan.settings.set("agentMode", "plan");
    const s = plan.sessions.create();
    await plan.runAndWait(s.id, "disque ?", { emit: () => {}, approve: async () => true });
    expect(lastTool(plan, s.id)!.isError).toBeFalsy();
    expect(plan.auditLog()[0]).toMatchObject({ tool: "system_disk_usage", decision: "automatique" });

    const denied = await core("system_info", {}, [{ tool: "system", decision: "deny" }]);
    const d = denied.sessions.create();
    await denied.runAndWait(d.id, "machine ?", { emit: () => {}, approve: async () => true });
    expect(lastTool(denied, d.id)).toMatchObject({ isError: true, content: expect.stringMatching(/politique de permissions/) });
    expect(denied.auditLog()[0]).toMatchObject({ tool: "system_info", decision: "refusé (règle)" });
  }, 120_000);

  it("phase 2 : un outil qui agit demande l'accord à chaque appel, avec une phrase qui dit l'action ; refusé il ne tourne pas", async () => {
    const refused = await core("system_control", { action: "notify", title: "ne doit jamais s'afficher" });
    const asked: { name: string; description: string }[] = [];
    const s1 = refused.sessions.create();
    await refused.runAndWait(s1.id, "notifie-moi", { emit: () => {}, approve: async (_s, call, description) => (asked.push({ name: call.name, description }), false) });
    expect(asked).toEqual([{ name: "system_control", description: "Afficher une notification de bureau : « ne doit jamais s'afficher »" }]);
    expect(lastTool(refused, s1.id)).toMatchObject({ isError: true, content: expect.stringMatching(/refusé/) });
    expect(refused.auditLog()).toEqual([expect.objectContaining({ tool: "system_control", decision: "refusé" })]);
    expect(refused.auditLog()[0]).not.toHaveProperty("ok"); // l'outil n'a pas tourné
  }, 60_000);

  it("phase 2 : une cible invalide (volet inconnu, adresse file:) est refusée AVANT toute demande d'accord", async () => {
    for (const [args, reason] of [
      [{ target: "settings", pane: "volet-qui-nexiste-pas" }, /Volet inconnu/],
      [{ target: "url", url: "file:///C:/Windows/System32/calc.exe" }, /http/],
      [{ target: "path", path: join(homedir(), ".ssh", "id_rsa") }, /emplacement protégé/],
    ] as const) {
      const c = await core("system_open", args);
      const s = c.sessions.create();
      await c.runAndWait(s.id, "ouvre", {
        emit: () => {},
        approve: async () => {
          throw new Error("l'approbateur ne devait pas être appelé");
        },
      });
      expect(lastTool(c, s.id)).toMatchObject({ isError: true, content: expect.stringMatching(reason) });
      expect(c.auditLog()).toEqual([expect.objectContaining({ tool: "system_open", decision: "refusé (règle)" })]);
    }
  }, 60_000);

  it("phase 2 : la lecture system_state ne demande rien ; le mode Plan bloque les outils qui agissent", async () => {
    const read = await core("system_state", {});
    const asked: string[] = [];
    const s = read.sessions.create();
    await read.runAndWait(s.id, "état ?", { emit: () => {}, approve: async (_s, call) => (asked.push(call.name), true) });
    expect(asked).toEqual([]);
    expect(JSON.parse(lastTool(read, s.id)!.content)).toHaveProperty("appearance");
    expect(read.auditLog()).toEqual([expect.objectContaining({ tool: "system_state", decision: "automatique", ok: true })]);

    const plan = await core("system_control", { action: "sleep_display" });
    plan.settings.set("agentMode", "plan");
    const p = plan.sessions.create();
    await plan.runAndWait(p.id, "éteins l'écran", { emit: () => {}, approve: async () => true });
    expect(lastTool(plan, p.id)).toMatchObject({ isError: true, content: expect.stringMatching(/Mode Plan/) });
    expect(plan.auditLog()[0]).toMatchObject({ tool: "system_control", decision: "bloqué (mode Plan)" });
  }, 60_000);

  it("phase 3 : un chemin protégé est refusé AVANT toute demande d'accord (l'approbateur échoue s'il est appelé)", async () => {
    const c = await core("system_files", { action: "trash", path: join(homedir(), ".ssh", "id_rsa") });
    const s = c.sessions.create();
    await c.runAndWait(s.id, "supprime ma clé", {
      emit: () => {},
      approve: async () => {
        throw new Error("l'approbateur ne devait pas être appelé");
      },
    });
    expect(lastTool(c, s.id)).toMatchObject({ isError: true, content: expect.stringMatching(/^Refusé : .*emplacement protégé/) });
    expect(c.auditLog()).toEqual([expect.objectContaining({ tool: "system_files", decision: "refusé (règle)" })]);
    expect(c.auditLog()[0]).not.toHaveProperty("ok");
  }, 60_000);

  it("phase 3 : la demande d'accord dit ce qui va se passer ; accordée, l'action a lieu et est auditée", async () => {
    const base = tempDir();
    const target = join(base, "nouveau-dossier");
    const c = await core("system_files", { action: "mkdir", path: target });
    const asked: string[] = [];
    const s = c.sessions.create();
    await c.runAndWait(s.id, "crée un dossier", { emit: () => {}, approve: async (_s, _call, description) => (asked.push(description), true) });
    expect(asked).toEqual([`Fichiers : créer le dossier ${target}`]);
    expect(existsSync(target)).toBe(true);
    expect(c.auditLog()).toEqual([expect.objectContaining({ tool: "system_files", decision: "accordé", ok: true })]);

    const refused = await core("system_files", { action: "mkdir", path: join(base, "refuse") });
    const r = refused.sessions.create();
    await refused.runAndWait(r.id, "crée", { emit: () => {}, approve: async () => false });
    expect(existsSync(join(base, "refuse"))).toBe(false);
  }, 60_000);

  it("phase 3 : arrêter un processus — la demande nomme le programme et le pid ; refusée il survit, accordée avec force il meurt", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const pid = child.pid!;
      const c = await core("system_kill_process", { pid, force: true });
      const asked: string[] = [];
      const s = c.sessions.create();
      await c.runAndWait(s.id, "arrête-le", { emit: () => {}, approve: async (_s, _call, description) => (asked.push(description), false) });
      expect(asked).toEqual([`Arrêter net (travail non enregistré perdu) node (pid ${pid})`]);
      expect(alive(pid)).toBe(true);
      expect(c.auditLog()[0]).toMatchObject({ tool: "system_kill_process", decision: "refusé" });

      const yes = await core("system_kill_process", { pid, force: true });
      const y = yes.sessions.create();
      await yes.runAndWait(y.id, "arrête-le", { emit: () => {}, approve: async () => true });
      const end = Date.now() + 8000;
      while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
      expect(yes.auditLog()[0]).toMatchObject({ tool: "system_kill_process", decision: "accordé", ok: true });

      // Jarod ne s'arrête jamais lui-même, même avec l'accord de l'utilisateur et l'approbation automatique.
      const self = await core("system_kill_process", { pid: process.pid, force: true });
      self.settings.set("autoApproveTools", true);
      const z = self.sessions.create();
      await self.runAndWait(z.id, "arrête-toi", { emit: () => {}, approve: async () => true });
      expect(lastTool(self, z.id)).toMatchObject({ isError: true, content: expect.stringMatching(/Jarod lui-même/) });
      expect(alive(process.pid)).toBe(true);
    } finally {
      child.kill();
    }
  }, 120_000);

  it("une règle ask exige l'accord, puis l'appel est audité comme accordé", async () => {
    const c = await core("system_info", {}, [{ tool: "system_info", decision: "ask" }]);
    const asked: string[] = [];
    const s = c.sessions.create();
    await c.runAndWait(s.id, "machine ?", { emit: () => {}, approve: async (_s, call) => (asked.push(call.name), true) });
    expect(asked).toEqual(["system_info"]);
    expect(c.auditLog()[0]).toMatchObject({ tool: "system_info", decision: "accordé", ok: true });
  }, 60_000);
});
