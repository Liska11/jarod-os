// SPECS-P5-AUTOMATION § 5 — barres AU1-AU7 (core), AT1-AT7 (outils).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { normalizeAutomationTickMs } from "../src/normalize.js";
import { makeCore } from "./helpers.js";

// ── AU1-AU7 : Core ──
/**
 * AV2-005 : `tick()` n'exécute une règle `schedule` que si son cron est DÛ, c'est-à-dire si
 * `nextCronRun(cron, dernière exécution)` est ≤ maintenant — et `nextCronRun` est STRICTEMENT
 * postérieur à son point de départ. Une règle créée à l'instant n'est donc JAMAIS due : ce recul
 * d'une minute PILE rend le cron « * * * * * » dû exactement une fois (l'échéance de la minute en
 * cours), sans rattraper de minutes passées.
 */
function rendreDue(core: { db: { run(sql: string, ...params: unknown[]): unknown } }): void {
  const now = Date.now();
  core.db.run("UPDATE automation_rules SET created_at = ?", Math.floor(now / 60_000) * 60_000 - 60_000);
}

describe("AU1-AU7 : Core AutomationService", () => {
  let core: any;

  beforeEach(async () => {
    core = await makeCore({ trackScheduleRun: true });
  });

  afterEach(() => core.dispose());

  it("AU1 : plugin chargé → ctx.automation existe, tickMs normalisé (défaut 30 000)", () => {
    expect(core.automation).toBeDefined();
    expect(typeof core.automation.start).toBe("function");
    expect(typeof core.automation.stop).toBe("function");
    // « tickMs normalisé » : 500 (hors bornes) DOIT être remonté à 30 000 à la réception du
    // tick, annoncé dans `automation:log`. C'est exactement ce que la mutation AM1 casse.
    const lines: string[] = [];
    core.app.on("automation:log", (l: string) => lines.push(l));
    core.automation.stop();
    core.automation.start(500);
    expect(lines.at(-1)).toContain("tickMs=30000");
    core.automation.stop();
  });

  it("AU2 : CRUD complet (create, list, get, update, delete)", async () => {
    const auto = core.automation;

    // Create
    const rule = auto.create({
      name: "Test Rule",
      trigger: { kind: "schedule", cron: "0 * * * *" },
      actions: [{ type: "agent", prompt: "Hello", mode: "plan" }],
    });
    expect(rule.id).toBeDefined();
    expect(rule.name).toBe("Test Rule");
    expect(rule.enabled).toBe(true);

    // List
    const list = auto.list();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(rule.id);

    // Get
    const got = auto.get(rule.id);
    expect(got).toBeDefined();
    expect(got!.name).toBe("Test Rule");

    // Update
    const updated = auto.update(rule.id, { name: "Updated", enabled: false });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Updated");
    expect(updated!.enabled).toBe(false);

    // List with filter
    const enabledList = auto.list({ enabled: true });
    expect(enabledList.length).toBe(0);
    const disabledList = auto.list({ enabled: false });
    expect(disabledList.length).toBe(1);

    // Delete
    const deleted = auto.delete(rule.id);
    expect(deleted).toBe(true);
    expect(auto.get(rule.id)).toBeUndefined();
    expect(auto.delete(rule.id)).toBe(false); // déjà supprimé
  });

  it("AU3 : tick → règles enabled exécutées une par une, actions agent enfilees dans jobs", async () => {
    const auto = core.automation;

    auto.create({
      name: "Rule 1",
      trigger: { kind: "schedule", cron: "* * * * *" },
      actions: [{ type: "agent", prompt: "Action 1", mode: "plan" }],
    });
    auto.create({
      name: "Rule 2",
      trigger: { kind: "schedule", cron: "* * * * *" },
      // DEUX actions agent dans la même règle : c'est là que « une par une » (vs parallèle, AM4)
      // se voit — deux tours schedule/run ne doivent JAMAIS être en vol en même temps.
      actions: [
        { type: "agent", prompt: "Action 2a", mode: "plan" },
        { type: "agent", prompt: "Action 2b", mode: "plan" },
      ],
    });
    // Règle désactivée
    auto.create({
      name: "Rule 3 (disabled)",
      trigger: { kind: "schedule", cron: "* * * * *" },
      actions: [{ type: "agent", prompt: "Action 3", mode: "plan" }],
      enabled: false,
    });
    rendreDue(core);

    // Nettoyer les jobs avant le test
    core.jobs.prune();

    // Tick manuel — la sonde de concurrence vit dans l'exécutant du helper (`core.maxActive`) :
    // `cordis.serial` s'arrête au premier callback qui rend une valeur, un second écouteur ne
    // serait JAMAIS appelé.
    await auto.tick();

    // 2 règles enabled, Rule 1 = 1 action, Rule 2 = 2 actions = 3 jobs enfilés.
    // Les jobs d'un même tick partagent la même milliseconde : l'ordre n'est pas garanti,
    // on vérifie l'ensemble (ruleId, actionIndex) et le regroupement par règle.
    const jobsList = core.jobs.list().filter((j: { kind: string }) => j.kind === "automation");
    expect(jobsList.length).toBe(3);

    const byRule = new Map<string, number[]>();
    for (const j of jobsList) {
      const p = j.payload as { ruleId: string; actionIndex: number };
      const arr = byRule.get(p.ruleId) ?? [];
      arr.push(p.actionIndex);
      byRule.set(p.ruleId, arr);
    }
    expect(byRule.size).toBe(2); // règle désactivée ignorée
    const sizes = [...byRule.values()].map((a) => a.sort((x, y) => x - y).join(","));
    expect(sizes.sort()).toEqual(["0", "0,1"]); // Rule 1 → [0], Rule 2 → [0,1]
    // « une par une » : jamais deux actions agent en vol simultané (détection AM4).
    expect(core.maxActive()).toBe(1);
  });

  it("AU4 : idempotence — une règle, une échéance, un job (autant d'appels qu'on veut)", async () => {
    const auto = core.automation;

    auto.create({
      name: "Idem Rule",
      trigger: { kind: "schedule", cron: "* * * * *" },
      actions: [{ type: "agent", prompt: "Test", mode: "plan" }],
    });
    rendreDue(core);

    // Une échéance précise, rejouée deux fois : la clé d'idempotence est
    // `sha256(ruleId:actionIndex:échéance)`, persistée sur `jobs.idempotency_key` (AV2-006) — le
    // second appel ne crée RIEN, même après un redémarrage (voir `automation-repro.test.ts`).
    const rule = auto.list()[0]!;
    const echeance = Date.now();
    await auto.executeRuleAt(rule, echeance);
    await auto.executeRuleAt(rule, echeance);

    const jobsList = core.jobs.list().filter((j: { kind: string }) => j.kind === "automation");
    expect(jobsList.length).toBe(1);
    expect(jobsList[0]!.payload).toMatchObject({ ruleId: rule.id, actionIndex: 0 });
  });

  it("AU5 : run manuel → exécution immédiate (hors tick), même chemin", async () => {
    const auto = core.automation;

    const rule = auto.create({
      name: "Manual Rule",
      trigger: { kind: "manual" },
      actions: [{ type: "agent", prompt: "Manual run", mode: "plan" }],
    });

    const result = await auto.run(rule.id);
    expect(result.ok).toBe(true);

    // Le job est créé et complété immédiatement → vérifier dans la liste des jobs automation
    const jobs = core.jobs.list().filter((j: { kind: string }) => j.kind === "automation");
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.payload).toMatchObject({ ruleId: rule.id, actionIndex: 0 });
    expect(jobs[0]!.status).toBe("done");
  });

  it("AU6 : règle enabled=false → ignorée au tick", async () => {
    const auto = core.automation;

    auto.create({
      name: "Disabled Rule",
      trigger: { kind: "schedule", cron: "* * * * *" },
      actions: [{ type: "agent", prompt: "Should not run", mode: "plan" }],
      enabled: false,
    });

    await auto.tick();
    // « ignorée au tick » = AUCUN job : une règle faussement exécutée serait enfilée PUIS aussitôt
    // clos (statut done), donc invisible de `due()` — c'est `list()` qui le révèle (détection AM3).
    const jobsList = core.jobs.list().filter((j: { kind: string }) => j.kind === "automation");
    expect(jobsList.length).toBe(0);
    expect(core.jobs.due().filter((j: { kind: string }) => j.kind === "automation").length).toBe(0);
  });

  it("AU7 : normalizeAutomationTickMs — bornes [1000, 3_600_000], défaut 30_000", () => {
    expect(normalizeAutomationTickMs(0)).toBe(30_000);
    expect(normalizeAutomationTickMs(-1)).toBe(30_000);
    expect(normalizeAutomationTickMs(500)).toBe(30_000);
    expect(normalizeAutomationTickMs(15_000)).toBe(15_000);
    expect(normalizeAutomationTickMs(30_000)).toBe(30_000);
    expect(normalizeAutomationTickMs(3_600_000)).toBe(3_600_000);
    expect(normalizeAutomationTickMs(4_000_000)).toBe(3_600_000);
    expect(normalizeAutomationTickMs("15000")).toBe(15_000);
    expect(normalizeAutomationTickMs("abc")).toBe(30_000);
    expect(normalizeAutomationTickMs(null)).toBe(30_000);
    expect(normalizeAutomationTickMs(undefined)).toBe(30_000);
  });
});