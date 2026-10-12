// SPECS-P5-UI-PARITE.md § 13.4 — l'accord des outils dans la BOUCLE D'AGENT : FC4 (service d'approbation en erreur ⇒ l'outil ne tourne pas) et le MOMENT D'EFFET des permissions
// (AR2, AR3, AR5, AR6, AR8) : lues à CHAQUE appel d'outil, jamais une fois par tour ; une restriction vaut pour l'appel SUIVANT, y compris dans le tour en cours, sans
// jamais interrompre un appel déjà lancé. Barres figées dans la spec AVANT le code.
import type { ChatRequest } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { awaitApproval, NEVER_ALWAYS, NEVER_ALWAYS_REASONS } from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

/** Un noyau dont le modèle demande, dans UN message, la liste `calls` d'outils (puis conclut). */
async function core(calls: { name: string; args?: Record<string, unknown> }[]) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  const app = await bootApp(plugins);
  const c = app.agent;
  c.settings.set("autoTitle", false);
  c.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.some((m) => m.role === "tool")
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: calls.map((x, i) => ({ id: `t${i + 1}`, name: x.name, args: x.args ?? {} })), stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  const log = { ran: 0, asked: [] as string[] };
  /** Un outil sensible de test ; `during` s'exécute PENDANT son exécution. */
  const danger = (during?: () => Promise<void> | void, name = "danger_x") =>
    c.tools.register({
      name,
      description: "Outil sensible de test",
      parameters: { type: "object", properties: {} },
      dangerous: true,
      source: "builtin",
      async run() {
        log.ran++;
        await during?.();
        return "fait";
      },
    });
  /** Un outil NON sensible qui change un réglage au moment où le modèle l'a demandé : l'intercalaire déterministe entre deux appels. */
  const probe = (change: () => void) =>
    c.tools.register({ name: "probe_x", description: "Change un réglage", parameters: { type: "object", properties: {} }, dangerous: false, source: "builtin", async run() { change(); return "changé"; } });
  const toolResults = (sid: string) => c.messages.list(sid).filter((m) => m.role === "tool");
  return { c, log, danger, probe, toolResults };
}
const answer = (log: { asked: string[] }, v: boolean | "reject" | "throw") => ({
  emit: () => {},
  approve: (_sid: string, call: { name: string }): Promise<boolean> => {
    log.asked.push(call.name);
    if (v === "throw") throw new Error("service d'approbation indisponible");
    return v === "reject" ? Promise.reject(new Error("service d'approbation en erreur")) : Promise.resolve(v);
  },
});

describe("FC4 — le service d'approbation en erreur ⇒ l'outil ne tourne PAS", () => {
  it("`approve` REJETTE ⇒ refusé, l'outil ne tourne pas, le modèle reçoit un refus", async () => {
    const { c, log, danger, toolResults } = await core([{ name: "danger_x" }]);
    danger();
    const s = c.sessions.create();
    await c.runAndWait(s.id, "vas-y", answer(log, "reject"));
    expect(log.ran).toBe(0);
    expect(toolResults(s.id).at(-1)).toMatchObject({ isError: true, content: expect.stringMatching(/refusé/i) });
    expect(c.auditLog()[0]).toMatchObject({ tool: "danger_x", decision: "refusé" });
  });

  it("`approve` LÈVE de façon synchrone ⇒ refusé, l'outil ne tourne pas, le tour va à son terme sans exception", async () => {
    const { c, log, danger, toolResults } = await core([{ name: "danger_x" }]);
    danger();
    const s = c.sessions.create();
    await c.runAndWait(s.id, "vas-y", answer(log, "throw"));
    expect(log.ran).toBe(0);
    expect(toolResults(s.id).at(-1)).toMatchObject({ isError: true });
    expect(c.auditLog()[0]).toMatchObject({ tool: "danger_x", decision: "refusé" });
  });

  it("`approve` ne répond JAMAIS : le délai refuse (`awaitApproval`), et l'arrêt du tour refuse", async () => {
    const never = new Promise<boolean>(() => {});
    expect(await awaitApproval(never, new AbortController().signal, 20)).toBe(false);
    const ctrl = new AbortController();
    const p = awaitApproval(never, ctrl.signal, 60_000);
    ctrl.abort();
    expect(await p).toBe(false);
    expect(await awaitApproval(Promise.resolve(true), new AbortController().signal, 1000)).toBe(true);
  });

  it("un refus ordinaire laisse l'outil non exécuté ; un accord l'exécute (témoin)", async () => {
    const a = await core([{ name: "danger_x" }]);
    a.danger();
    const sa = a.c.sessions.create();
    await a.c.runAndWait(sa.id, "vas-y", answer(a.log, false));
    expect(a.log.ran).toBe(0);
    const b = await core([{ name: "danger_x" }]);
    b.danger();
    const sb = b.c.sessions.create();
    await b.c.runAndWait(sb.id, "vas-y", answer(b.log, true));
    expect(b.log.ran).toBe(1);
  });
});

describe("moment d'effet : lu à CHAQUE appel d'outil, y compris dans le tour en cours", () => {
  it("AR3 : un outil « toujours » RETIRÉ entre deux appels du même tour : le 2ᵉ redemande ; témoin : sans retrait, le 2ᵉ ne redemande pas", async () => {
    const t = await core([{ name: "danger_x" }, { name: "probe_x" }, { name: "danger_x" }]);
    t.danger();
    t.probe(() => t.c.settings.set("alwaysAllowTools", []));
    t.c.settings.set("alwaysAllowTools", ["danger_x"]);
    const s = t.c.sessions.create();
    await t.c.runAndWait(s.id, "vas-y", answer(t.log, false));
    expect(t.log.asked, "le 1ᵉʳ appel passe (dans la liste), le 2ᵉ redemande après le retrait").toEqual(["danger_x"]);
    expect(t.log.ran, "le 1ᵉʳ a tourné, le 2ᵉ a été refusé").toBe(1);

    const w = await core([{ name: "danger_x" }, { name: "probe_x" }, { name: "danger_x" }]);
    w.danger();
    w.probe(() => {});
    w.c.settings.set("alwaysAllowTools", ["danger_x"]);
    await w.c.runAndWait(w.c.sessions.create().id, "vas-y", answer(w.log, false));
    expect(w.log.asked, "témoin : jamais redemandé").toEqual([]);
    expect(w.log.ran).toBe(2);
  });

  it("AR2 : un octroi fait par la fenêtre d'accord (« toujours ») au 1ᵉʳ appel vaut pour le 2ᵉ du MÊME tour", async () => {
    const t = await core([{ name: "danger_x" }, { name: "danger_x" }]);
    t.danger();
    const s = t.c.sessions.create();
    await t.c.runAndWait(s.id, "vas-y", {
      emit: () => {},
      approve: async (_sid: string, call: { name: string }) => {
        t.log.asked.push(call.name);
        t.c.settings.set("alwaysAllowTools", ["danger_x"]); // ce que fait la fenêtre d'accord en répondant « toujours »
        return true;
      },
    });
    expect(t.log.asked).toEqual(["danger_x"]);
    expect(t.log.ran).toBe(2);
  });

  it("AR5 : l'accord automatique ÉTEINT entre deux appels : le 2ᵉ redemande ; ALLUMÉ entre deux appels : le 2ᵉ passe", async () => {
    const off = await core([{ name: "probe_x" }, { name: "danger_x" }]);
    off.danger();
    off.probe(() => off.c.settings.set("autoApproveTools", false));
    off.c.settings.set("autoApproveTools", true);
    await off.c.runAndWait(off.c.sessions.create().id, "vas-y", answer(off.log, false));
    expect(off.log.asked).toEqual(["danger_x"]);
    expect(off.log.ran).toBe(0);

    const on = await core([{ name: "probe_x" }, { name: "danger_x" }]);
    on.danger();
    on.probe(() => on.c.settings.set("autoApproveTools", true));
    await on.c.runAndWait(on.c.sessions.create().id, "vas-y", answer(on.log, false));
    expect(on.log.asked).toEqual([]);
    expect(on.log.ran).toBe(1);
  });

  it("AR6 : le mode Plan de la CONVERSATION activé entre deux appels : le 2ᵉ est refusé « Mode Plan », sans demande (le réglage global ne vaut que pour les conversations créées ensuite)", async () => {
    const t = await core([{ name: "probe_x" }, { name: "danger_x" }]);
    t.danger();
    let sid = "";
    t.probe(() => t.c.updateSessionContext(sid, { agentMode: "plan" }));
    const s = t.c.sessions.create();
    sid = s.id;
    await t.c.runAndWait(s.id, "vas-y", answer(t.log, true));
    expect(t.log.asked).toEqual([]);
    expect(t.log.ran).toBe(0);
    expect(t.toolResults(s.id).at(-1)).toMatchObject({ isError: true, content: expect.stringMatching(/Mode Plan/) });
  });

  it("AR8 : un appel DÉJÀ LANCÉ n'est pas interrompu par une révocation faite pendant son exécution", async () => {
    const t = await core([{ name: "danger_x" }]);
    let revoked = false;
    t.danger(async () => {
      t.c.settings.set("alwaysAllowTools", []); // révocation PENDANT l'appel
      revoked = true;
      await new Promise((r) => setTimeout(r, 30));
    });
    t.c.settings.set("alwaysAllowTools", ["danger_x"]);
    const s = t.c.sessions.create();
    await t.c.runAndWait(s.id, "vas-y", answer(t.log, false));
    expect(revoked).toBe(true);
    expect(t.log.ran).toBe(1);
    expect(t.toolResults(s.id).at(-1)).toMatchObject({ content: "fait" });
    expect(t.log.asked).toEqual([]);
  });
});

// SPECS-P5-UI-PARITE.md § 23 : une dispense « toujours » DÉJÀ enregistrée n'a plus d'effet sur les outils de NEVER_ALWAYS.
// web_fetch ajouté le 2026-10-05 (décision de l'utilisateur, mission session 2 étape 0) : un accord permanent sur une URL arbitraire n'a pas de sens.
// system_files, system_kill_process et system_quit_app ajoutés le 2026-10-11 (décision de l'utilisateur, outils système Windows).
const FIVE = ["run_shell", "android_shell", "skill_hub_install", "cronjob", "http_request", "web_fetch", "system_files", "system_kill_process", "system_quit_app"];
describe("NEVER_ALWAYS dans la boucle d'agent (§ 23.2)", () => {
  it.each(FIVE)("RN4 %s listé dans alwaysAllowTools : l'appel POSE la demande ; refusée, l'outil ne tourne pas ; RN9 l'entrée reste lisible (non supprimée en silence)", async (name) => {
    const t = await core([{ name }]);
    t.danger(undefined, name);
    t.c.settings.set("alwaysAllowTools", [name]);
    const s = t.c.sessions.create();
    await t.c.runAndWait(s.id, "vas-y", answer(t.log, false));
    expect(t.log.asked, "la demande est posée malgré l'entrée").toEqual([name]);
    expect(t.log.ran, "refusée : l'outil ne tourne pas").toBe(0);
    expect(t.c.auditLog()[0]).toMatchObject({ tool: name, decision: "refusé" });
    expect(t.c.settings.get("alwaysAllowTools"), "RN9 : l'entrée n'est pas supprimée").toEqual([name]);
  });

  it.each(["danger_x", "write_file", "edit_file"])("RN5 témoin : %s listé dans alwaysAllowTools n'est PAS redemandé (la dispense reste)", async (name) => {
    const t = await core([{ name }]);
    t.danger(undefined, name);
    t.c.settings.set("alwaysAllowTools", [name]);
    await t.c.runAndWait(t.c.sessions.create().id, "vas-y", answer(t.log, false));
    expect(t.log.asked).toEqual([]);
    expect(t.log.ran).toBe(1);
  });

  it("web_fetch RÉEL (outil intégré) : « Toujours autoriser » enregistré n'exempte pas l'appel SUIVANT ; web_search reste en lecture seule", async () => {
    const t = await core([
      { name: "web_fetch", args: { url: "https://example.invalid/a" } },
      { name: "web_fetch", args: { url: "https://example.invalid/b" } },
    ]);
    expect(t.c.tools.get("web_fetch")?.dangerous, "web_fetch est sensible (H3)").toBe(true);
    expect(t.c.tools.get("web_search")?.dangerous ?? false, "web_search reste RO (décision session 1)").toBe(false);
    t.c.settings.set("alwaysAllowTools", ["web_fetch"]); // l'utilisateur a cliqué « Toujours autoriser »
    await t.c.runAndWait(t.c.sessions.create().id, "vas-y", answer(t.log, false));
    expect(t.log.asked, "chaque appel pose la demande").toEqual(["web_fetch", "web_fetch"]);
    expect(t.c.auditLog().map((e) => e.decision)).toEqual(["refusé", "refusé"]);
  });

  it("RN6 garde de dérive : chaque outil de NEVER_ALWAYS a un motif non vide, et les motifs n'ont pas d'autre clé", () => {
    expect([...NEVER_ALWAYS].sort()).toEqual([...FIVE].sort());
    expect(Object.keys(NEVER_ALWAYS_REASONS).sort()).toEqual([...NEVER_ALWAYS].sort());
    for (const name of NEVER_ALWAYS) expect(NEVER_ALWAYS_REASONS[name]!.trim().length, name).toBeGreaterThan(20);
  });
});
