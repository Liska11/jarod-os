// Cockpit, lot 2 : la porte unique (executeGuardedTool) vérifie l'effet obtenu, consigne chaque action dans le registre des tâches
// (étapes, statut, preuve) et sait l'annuler ; la décision de permission tient compte de la CIBLE résolue de l'appel.
import { PermissionGuard, unifiedGate } from "@jarod/plugin-permissions";
import { ToolRegistry, type ToolDef } from "@jarod/plugin-tools";
import { describe, expect, it } from "vitest";
import { executeGuardedTool } from "../src/agent.js";
import { TaskLedger, type TaskRecord } from "../src/tasks.js";

const settings = { disabledTools: [], agentMode: "normal", autoApproveTools: false, alwaysAllowTools: [], workspace: null } as never;
const yes = { approve: async () => true };
const no = { approve: async () => false };

function rig(defs: Partial<ToolDef>[], rules: ConstructorParameters<typeof PermissionGuard>[0] = []) {
  const tools = new ToolRegistry();
  for (const d of defs) tools.register({ description: "outil", parameters: { type: "object", properties: {} }, source: "builtin", run: async () => "fait", ...d } as ToolDef);
  const tasks = new TaskLedger();
  const gate = unifiedGate(new PermissionGuard(rules), (n) => Boolean(tools.get(n)));
  const call = (name: string, args: Record<string, unknown> = {}, hooks = yes, signal = new AbortController().signal) =>
    executeGuardedTool(tools, "s1", { id: "c1", name, args }, signal, hooks, settings, { gate, tasks });
  return { tools, tasks, call };
}

describe("preuve d'exécution", () => {
  it("une vérification constatée est jointe au résultat et à la tâche", async () => {
    const { call, tasks } = rig([{ name: "make", dangerous: true, verify: async () => ({ status: "verified", evidence: "fichier présent, 12 octets" }) }]);
    const r = await call("make");
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/\[Vérification : constatée\] fichier présent, 12 octets/);
    expect(tasks.list()[0]).toMatchObject({ tool: "make", status: "done", proof: { status: "verified" } });
  });

  it("une vérification en échec rend l'appel en erreur : un code de retour positif ne suffit pas", async () => {
    const { call, tasks } = rig([{ name: "make", dangerous: true, verify: async () => ({ status: "failed", evidence: "le fichier n'existe pas" }) }]);
    const r = await call("make");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/\[Vérification : ÉCHEC\] le fichier n'existe pas/);
    expect(tasks.list()[0]!.status).toBe("failed");
  });

  it("une vérification qui lève est dite impossible, jamais constatée", async () => {
    const { call, tasks } = rig([{ name: "make", dangerous: true, verify: async () => { throw new Error("lecture impossible"); } }]);
    const r = await call("make");
    expect(r.content).toMatch(/\[Vérification : impossible\]/);
    expect(tasks.list()[0]!.proof).toMatchObject({ status: "unverifiable" });
  });

  it("un outil à effet sans vérification : la tâche le DIT, le résultat de l'outil n'est pas modifié", async () => {
    const { call, tasks } = rig([{ name: "act", dangerous: true }]);
    expect((await call("act")).content).toBe("fait");
    expect(tasks.list()[0]!.proof).toEqual({ status: "unverifiable", evidence: "aucune vérification prévue pour cet outil" });
  });

  it("une lecture simple ne crée pas de tâche", async () => {
    const { call, tasks } = rig([{ name: "look" }]);
    await call("look");
    expect(tasks.list()).toEqual([]);
  });
});

describe("registre des tâches", () => {
  it("étapes dans l'ordre, cible et action résolue (précheck) consignées", async () => {
    const { call, tasks } = rig([{ name: "open", dangerous: true, targetOf: (a) => String(a.app), precheck: (a) => `Lancer ${String(a.app)}` }]);
    await call("open", { app: "Paint" });
    const t = tasks.list()[0] as TaskRecord;
    expect(t).toMatchObject({ tool: "open", target: "Paint", summary: "Lancer Paint", sessionId: "s1" });
    expect(t.steps.map((s) => s.step)).toEqual(["demandée", "accord demandé", "accordée", "exécution", "terminée"]);
    expect(t.endedAt).toBeGreaterThanOrEqual(t.createdAt);
  });

  it("refus de l'utilisateur et refus d'une règle sont des tâches refusées, l'outil ne tourne pas", async () => {
    let ran = 0;
    const { call, tasks } = rig([{ name: "act", dangerous: true, run: async () => String(++ran) }], [{ tool: "act", target: "interdit", decision: "deny" }]);
    await call("act", {}, no);
    expect(tasks.list()[0]!.status).toBe("refused");
    expect(ran).toBe(0);
  });

  it("annuler une tâche en cours coupe l'outil (son signal) et la marque annulée", async () => {
    const { call, tasks } = rig([
      {
        name: "slow",
        dangerous: true,
        run: (_a, ctx) => new Promise((_res, rej) => ctx.signal?.addEventListener("abort", () => rej(new Error("arrêté")))),
      },
    ]);
    const pending = call("slow");
    await new Promise((r) => setTimeout(r, 10));
    const running = tasks.list()[0]!;
    expect(running.status).toBe("running");
    expect(tasks.cancel(running.id)).toBe(true);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(tasks.get(running.id)!.status).toBe("cancelled");
    expect(tasks.cancel(running.id)).toBe(false);
  });

  it("annuler pendant la demande d'accord : rien ne tourne", async () => {
    let ran = false;
    const { call, tasks } = rig([{ name: "act", dangerous: true, run: async () => ((ran = true), "x") }]);
    const pending = call("act", {}, { approve: () => new Promise<boolean>(() => {}) });
    await new Promise((r) => setTimeout(r, 10));
    expect(tasks.list()[0]!.status).toBe("awaiting-approval");
    tasks.cancel(tasks.list()[0]!.id);
    await pending;
    expect(ran).toBe(false);
    expect(tasks.list()[0]!.status).toBe("cancelled");
  });

  it("borné en mémoire, persisté par le magasin fourni, relu au démarrage", () => {
    const saved: TaskRecord[] = [];
    const store = { save: (t: TaskRecord) => void saved.push(t), load: () => saved.slice() };
    const a = new TaskLedger({ store, max: 3 });
    for (let i = 0; i < 5; i++) a.finish(a.begin({ sessionId: "s", tool: `t${i}`, summary: "x" }).id, "done");
    expect(a.list()).toHaveLength(3);
    const b = new TaskLedger({ store, max: 3 });
    expect(b.list().map((t) => t.tool)).toEqual(["t4", "t3", "t2"]);
  });
});

describe("permission par cible dans la porte unique", () => {
  const def = (run = async () => "ouvert") => ({ name: "open", dangerous: true, targetOf: (a: Record<string, unknown>) => String(a.app ?? ""), run });

  it("deny ciblé : refusé pour sa cible, accordé ailleurs", async () => {
    const { call } = rig([def()], [{ tool: "open", target: "*steam*", decision: "deny" }]);
    expect((await call("open", { app: "Steam" })).content).toMatch(/politique de permissions/);
    expect((await call("open", { app: "Paint" })).content).toBe("ouvert");
  });

  it("une cible que l'outil n'a pas su dire n'échappe pas à un deny ciblé (fail-closed)", async () => {
    const { call } = rig([{ ...def(), targetOf: () => { throw new Error("?"); } }], [{ tool: "open", target: "*steam*", decision: "deny" }]);
    expect((await call("open", { app: "Steam" })).content).toMatch(/politique de permissions/);
  });

  it("allow ciblé temporaire : un outil sensible garde son accord, comme avec un allow sans cible (rien n'est dispensé en silence)", async () => {
    const asked: string[] = [];
    const hooks = { approve: async (_s: string, c: { args: Record<string, unknown> }) => (asked.push(String(c.args.app)), true) };
    const { call } = rig([def()], [{ tool: "open", target: "Paint", decision: "allow", expiresAt: Date.now() + 60_000 }]);
    await call("open", { app: "Paint" }, hooks as never);
    await call("open", { app: "Steam" }, hooks as never);
    // L'outil est sensible : allow laisse jouer l'accord de l'outil (comme pour une règle allow sans cible). Rien n'est dispensé en silence.
    expect(asked).toEqual(["Paint", "Steam"]);
  });
});

describe("dans la vraie boucle d'agent", () => {
  it("write_file accordé : tâche terminée, preuve constatée dans le résultat vu par le modèle, tâche persistée au flux `tasks`", async () => {
    const { makeCore, tempDir } = await import("./helpers.js");
    const core = await makeCore();
    const ws = tempDir();
    core.settings.set("autoTitle", false);
    core.settings.set("workspace", ws);
    core.providers.client = () =>
      ({
        chat: async (req: { messages: { role: string }[] }) =>
          req.messages.some((m) => m.role === "tool")
            ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
            : { text: "", thinking: "", toolCalls: [{ id: "t1", name: "write_file", args: { path: "a.txt", content: "bonjour" } }], stopReason: "tool_use" },
        listModels: async () => [],
      }) as never;
    const s = core.sessions.create();
    await core.runAndWait(s.id, "écris", { emit: () => {}, approve: async () => true });
    const tool = core.messages.list(s.id).filter((m) => m.role === "tool").at(-1)!;
    expect(tool.content).toMatch(/\[Vérification : constatée\] a\.txt relu : 7 octets/);
    const task = core.tasks.list()[0]!;
    expect(task).toMatchObject({ tool: "write_file", target: "a.txt", status: "done", proof: { status: "verified" } });
    expect(core.events.list({ stream: "tasks", limit: 10 }).map((e) => (e.data as TaskRecord).id)).toContain(task.id);
    await core.dispose();
  });
});

describe("outil `task_status`", () => {
  it("rend les actions de CETTE conversation avec leur preuve, jamais celles d'une autre", async () => {
    const { taskStatusTool } = await import("../src/tasks.js");
    const ledger = new TaskLedger();
    const a = ledger.begin({ sessionId: "s1", tool: "write_file", summary: "Écrire a.txt", target: "a.txt" });
    ledger.finish(a.id, "done", { proof: { status: "verified", evidence: "a.txt relu : 7 octets" } });
    ledger.finish(ledger.begin({ sessionId: "autre", tool: "run_shell", summary: "Lancer autre.bat" }).id, "done");
    const out = await taskStatusTool(ledger).run({}, { sessionId: "s1" });
    expect(out).toBe("terminée · Écrire a.txt [a.txt] — constaté : a.txt relu : 7 octets");
    expect(await taskStatusTool(ledger).run({}, { sessionId: "vide" })).toMatch(/Aucune action/);
  });
});
