// SPECS-P5-AUTOMATION.md § 5 — barres AT1-AT7 (outils agent). Figées AVANT le code.
// Le garde est celui du CŒUR (`executeGuardedTool`, plugin-agent) : les outils sensibles exigent
// un accord, et sans accord (backgroundHooks) TOUS refusent (AT7) — jamais « ils tournent quand
// même ».
import { DEFAULT_SETTINGS, type Settings } from "@jarod/contracts";
import { executeGuardedTool } from "@jarod/plugin-agent";
import type { ToolCall } from "@jarod/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { automationTools } from "../src/tools.js";
import { makeCore } from "./helpers.js";

afterEach(() => {});

const ctx = { sessionId: "s1", workspace: null };
const settings = (): Settings => ({ ...DEFAULT_SETTINGS });

/** Les outils du paquet, enregistrés dans un vrai registre. */
async function setup() {
  const core = await makeCore();
  const tools = automationTools(core.automation);
  return { core, tools, byName: (n: string) => tools.find((t) => t.name === n)! };
}

/** Le portail du garde unifié : fourni par plugin-permissions en production. Ici on teste l'ACCORD des
 * outils sensibles, pas les règles de permissions — on l'ouvre donc explicitement (son absence vaut
 * « deny » depuis AV2-008, et un portail fermé ferait passer tous ces cas pour des refus de règle). */
const GATE = { decide: () => "allow" as const };

/** Passe un appel par le garde du cœur avec la réponse d'accord donnée. */
async function guarded(
  tools: ReturnType<typeof automationTools>,
  call: ToolCall,
  approve: boolean,
): Promise<{ content: string; isError: boolean }> {
  const { ToolRegistry } = await import("@jarod/plugin-tools");
  const reg = new ToolRegistry();
  for (const t of tools) reg.register(t);
  return executeGuardedTool(reg, "s1", call, new AbortController().signal, { approve: async () => approve }, settings(), { gate: GATE });
}

const NOTIFY = { type: "notify", title: "T", body: "b" } as const;

describe("AT1-AT7 — outils agent d'automation", () => {
  it("AT1 : automation_list rend les règles (id, name, enabled, trigger.kind, actions.length)", async () => {
    const { core, byName } = await setup();
    core.automation.create({ name: "R1", trigger: { kind: "manual" }, actions: [{ type: "agent", prompt: "p", mode: "plan" }] });
    core.automation.create({ name: "R2", trigger: { kind: "schedule", cron: "* * * * *" }, actions: [NOTIFY, NOTIFY] });

    const out = await byName("automation_list").run({}, ctx);
    const rows = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.name).sort()).toEqual(["R1", "R2"]);
    const r1 = rows.find((r) => r.name === "R1")!;
    expect(r1.id).toEqual(expect.any(String));
    expect(r1.enabled).toBe(true);
    expect((r1.trigger as { kind: string }).kind).toBe("manual");
    expect(r1.actionsCount).toBe(1);
    const r2 = rows.find((r) => r.name === "R2")!;
    expect((r2.trigger as { kind: string }).kind).toBe("schedule");
    expect(r2.actionsCount).toBe(2);
    // Le filtre enabled ne montre que les actives.
    core.automation.update(r2.id as string, { enabled: false });
    const only = await byName("automation_list").run({ enabled: true }, ctx);
    expect(only).toContain("R1");
    expect(only).not.toContain("R2");
  });

  it("AT2 : automation_get rend la règle complète (trigger + actions)", async () => {
    const { core, byName } = await setup();
    const rule = core.automation.create({
      name: "Complète",
      trigger: { kind: "schedule", cron: "0 * * * *" },
      actions: [{ type: "agent", prompt: "Fais", mode: "build" }, NOTIFY],
    });
    const out = await byName("automation_get").run({ id: rule.id }, ctx);
    const got = JSON.parse(out) as { id: string; trigger: { kind: string; cron: string }; actions: unknown[] };
    expect(got.id).toBe(rule.id);
    expect(got.trigger).toMatchObject({ kind: "schedule", cron: "0 * * * *" });
    expect(got.actions).toHaveLength(2);
    // Inconnu → message dit, pas un crash.
    expect(await byName("automation_get").run({ id: "nope" }, ctx)).toMatch(/introuvable/i);
  });

  it("AT3 : automation_create valide (trigger connu, actions non vides) → créée, accord demandé", async () => {
    const { core, byName } = await setup();
    const create = byName("automation_create");
    expect(create.dangerous).toBe(true); // l'accord est demandé par le garde

    // Valide, ACCORDÉ : la règle existe.
    const ok = await guarded(
      automationTools(core.automation),
      { id: "c1", name: "automation_create", args: { name: "Créée", trigger: { kind: "manual" }, actions: [NOTIFY] } },
      true,
    );
    expect(ok.isError).toBe(false);
    expect(core.automation.list().map((r) => r.name)).toContain("Créée");

    // Trigger INCONNU : refus dit, rien n'est créé (la dépendance de la barre AM7).
    const bad = await create.run({ name: "X", trigger: { kind: "bogus" }, actions: [NOTIFY] }, ctx);
    expect(bad).toMatch(/erreur/i);
    expect(core.automation.list().map((r) => r.name)).not.toContain("X");

    // schedule sans cron → refus dit.
    expect(await create.run({ name: "Y", trigger: { kind: "schedule" }, actions: [NOTIFY] }, ctx)).toMatch(/erreur/i);
    // actions vides → refus dit.
    expect(await create.run({ name: "Z", trigger: { kind: "manual" }, actions: [] }, ctx)).toMatch(/erreur/i);
    expect(core.automation.list()).toHaveLength(1);
  });

  it("AT4 : automation_update partiel (name ou enabled seul) → OK, accord demandé", async () => {
    const { core, byName } = await setup();
    const u = byName("automation_update");
    expect(u.dangerous).toBe(true);
    const rule = core.automation.create({
      name: "Avant",
      trigger: { kind: "manual" },
      actions: [{ type: "agent", prompt: "P", mode: "plan" }],
    });

    // name SEULEMENT : les autres champs (actions, trigger) sont préservés.
    const r1 = await guarded(automationTools(core.automation), { id: "u1", name: "automation_update", args: { id: rule.id, name: "Après" } }, true);
    expect(r1.isError).toBe(false);
    const after = core.automation.get(rule.id)!;
    expect(after.name).toBe("Après");
    expect(after.actions).toHaveLength(1);
    expect(after.trigger).toEqual({ kind: "manual" });

    // enabled SEULEMENT.
    const r2 = await guarded(automationTools(core.automation), { id: "u2", name: "automation_update", args: { id: rule.id, enabled: false } }, true);
    expect(r2.isError).toBe(false);
    expect(core.automation.get(rule.id)!.enabled).toBe(false);
    expect(core.automation.get(rule.id)!.name).toBe("Après"); // le nom n'a pas bougé

    // Trigger inconnu → refus dit, règle inchangée.
    expect(await u.run({ id: rule.id, trigger: { kind: "bogus" } }, ctx)).toMatch(/erreur/i);
    expect(core.automation.get(rule.id)!.trigger).toEqual({ kind: "manual" });
    // Règle inconnue → message dit.
    expect(await u.run({ id: "nope", name: "x" }, ctx)).toMatch(/introuvable/i);
  });

  it("AT5 : automation_delete → règle disparue, accord demandé", async () => {
    const { core, byName } = await setup();
    const d = byName("automation_delete");
    expect(d.dangerous).toBe(true);
    const rule = core.automation.create({ name: "À virer", trigger: { kind: "manual" }, actions: [NOTIFY] });

    // Sans accord : le garde refuse AVANT l'outil → la règle est encore là.
    const refused = await guarded(automationTools(core.automation), { id: "d1", name: "automation_delete", args: { id: rule.id } }, false);
    expect(refused.isError).toBe(true);
    expect(core.automation.get(rule.id)).toBeDefined();

    const ok = await guarded(automationTools(core.automation), { id: "d2", name: "automation_delete", args: { id: rule.id } }, true);
    expect(ok.isError).toBe(false);
    expect(core.automation.get(rule.id)).toBeUndefined();
    expect(await d.run({ id: rule.id }, ctx)).toMatch(/introuvable/i);
  });

  it("AT6 : automation_run → exécution immédiate enfilée, accord demandé", async () => {
    const { core, byName } = await setup();
    const r = byName("automation_run");
    expect(r.dangerous).toBe(true);
    const rule = core.automation.create({ name: "Manuelle", trigger: { kind: "manual" }, actions: [NOTIFY] });

    // Sans accord : rien n'a tourné.
    const refused = await guarded(automationTools(core.automation), { id: "r1", name: "automation_run", args: { id: rule.id } }, false);
    expect(refused.isError).toBe(true);
    expect(core.jobs.list().filter((j) => j.kind === "automation")).toHaveLength(0);

    const ok = await guarded(automationTools(core.automation), { id: "r2", name: "automation_run", args: { id: rule.id } }, true);
    expect(ok.isError).toBe(false);
    expect(ok.content).toMatch(/exécutée/);
    // L'action notify a tourné : la notification existe, le job est clos.
    expect(core.storage.notifications.list().map((n) => n.title)).toContain("T");
    expect(core.jobs.list().filter((j) => j.kind === "automation")).toHaveLength(1);
    // Règle inconnue / désactivée → message dit.
    expect(await r.run({ id: "nope" }, ctx)).toMatch(/❌|introuvable/i);
    core.automation.update(rule.id, { enabled: false });
    expect(await r.run({ id: rule.id }, ctx)).toMatch(/❌/);
  });

  it("AT7 : sans accord (backgroundHooks) → TOUS les outils sensibles refusent", async () => {
    const { core, tools } = await setup();
    const rule = core.automation.create({ name: "Cible", trigger: { kind: "manual" }, actions: [NOTIFY] });
    const before = JSON.stringify(core.automation.list());

    const calls: ToolCall[] = [
      { id: "a1", name: "automation_create", args: { name: "N", trigger: { kind: "manual" }, actions: [NOTIFY] } },
      { id: "a2", name: "automation_update", args: { id: rule.id, name: "N2" } },
      { id: "a3", name: "automation_delete", args: { id: rule.id } },
      { id: "a4", name: "automation_run", args: { id: rule.id } },
    ];
    for (const call of calls) {
      const out = await guarded(tools, call, false); // backgroundHooks : approve → false
      expect(out.isError, `${call.name} doit être refusé sans accord`).toBe(true);
      expect(out.content, call.name).toMatch(/refusé/i);
    }
    // Aucun côté effet : ni règle créée/modifiée/supprimée, ni job enfilé.
    expect(JSON.stringify(core.automation.list())).toBe(before);
    expect(core.jobs.list().filter((j) => j.kind === "automation")).toHaveLength(0);
    // Les outils de LECTURE restent libres (list/get n'exigent pas d'accord).
    for (const name of ["automation_list", "automation_get"]) {
      const out = await guarded(tools, { id: "r", name, args: name === "automation_get" ? { id: rule.id } : {} }, false);
      expect(out.isError, `${name} est une lecture`).toBe(false);
    }
  });
});
