/**
 * H5/H6/H7 (audit v4 § 1) — le calcul du créneau « dû » d'une règle d'automation.
 *
 * Avant correctif :
 *  - H5 : chaque créneau manqué était rejoué, UN PAR TICK — une règle horaire après 5 h d'arrêt lançait
 *    5 tours d'agent (168 après une semaine) ;
 *  - H6 : `getLastRunTime` ne comptait que les jobs `done` : après UN échec, `nextRun` restait le créneau
 *    échoué, dont la clé d'idempotence existait déjà → la règle ne tournait PLUS JAMAIS ;
 *  - H7 : `run()` répondait `ok: true` alors que l'action avait échoué.
 *
 * Le service est piloté avec une horloge INJECTÉE (pas d'attente réelle) ; le tick de fond du plugin est
 * écarté en construisant notre propre service sur la base du noyau.
 */
import { JobsService } from "@jarod/plugin-scheduler";
import { describe, expect, it } from "vitest";
import { AutomationService } from "../src/automation.js";
import { makeCore } from "./helpers.js";

const H = 3_600_000;

/** Un service d'automation sur la base d'un VRAI noyau, avec une horloge que le test fait avancer. */
async function harness(opts: { fails?: string } = {}) {
  const core = await makeCore();
  let t = Date.UTC(2026, 0, 1, 12, 30, 0); // 12:30
  const runs: string[] = [];
  const logs: string[] = [];
  const jobs = new JobsService({ db: core.db, now: () => t });
  const automation = new AutomationService({
    db: core.db,
    jobs,
    now: () => t,
    runAgent: async (prompt) => {
      runs.push(prompt);
      return opts.fails
        ? { sessionId: "s", ok: false, summary: opts.fails }
        : { sessionId: "s", ok: true, summary: "ok" };
    },
    notify: () => {},
    log: (line) => logs.push(line),
  });
  const rule = automation.create({
    name: "h",
    trigger: { kind: "schedule", cron: "0 * * * *" },
    actions: [{ type: "agent", prompt: "p" }],
  });
  return {
    core,
    jobs,
    automation,
    runs,
    logs,
    rule,
    now: () => t,
    at: (v: number) => {
      t = v;
    },
  };
}

describe("H5 — jamais de rattrapage en rafale", () => {
  it("une règle horaire créée il y a 5 h ne lance QU'UN tour, même après 8 ticks", async () => {
    const h = await harness();
    // La règle existe depuis 5 h : 5 créneaux sont manqués (08:00 … 12:00).
    h.core.db.run("UPDATE automation_rules SET created_at = ? WHERE id = ?", h.now() - 5 * H, h.rule.id);

    for (let i = 0; i < 8; i++) await h.automation.tick();

    expect(h.runs, "un seul créneau exécuté, pas cinq").toHaveLength(1);
    expect(h.logs.some((l) => /4 créneau\(x\) manqué\(s\) sauté\(s\)/.test(l)), "les créneaux sautés sont dits").toBe(
      true,
    );
  });

  it("le créneau exécuté est le DERNIER dû, pas le premier", async () => {
    const h = await harness();
    h.core.db.run("UPDATE automation_rules SET created_at = ? WHERE id = ?", h.now() - 5 * H, h.rule.id);
    await h.automation.tick();

    const job = h.jobs.list().find((j) => j.kind === "automation");
    expect(job?.dueAt, "12:00 (le plus récent dû), pas 08:00").toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
  });

  it("une règle créée à l'instant ne se déclenche pas avant son premier créneau", async () => {
    const h = await harness();
    await h.automation.tick();
    expect(h.runs).toHaveLength(0);
  });
});

describe("H6 — un échec ne bloque plus la règle pour toujours", () => {
  it("après un échec, le créneau SUIVANT tourne quand l'heure avance", async () => {
    const h = await harness({ fails: "boom" });
    h.core.db.run("UPDATE automation_rules SET created_at = ? WHERE id = ?", h.now() - 5 * H, h.rule.id);

    await h.automation.tick(); // 12:00 — échoue
    expect(h.runs).toHaveLength(1);
    expect(h.jobs.list("failed")).toHaveLength(1);

    // Une heure plus tard : le créneau 13:00 est dû, et l'échec de 12:00 est TRAITÉ (donc dépassé).
    h.at(h.now() + 2 * H);
    await h.automation.tick();
    expect(h.runs, "la règle repart au créneau suivant").toHaveLength(2);
  });

  it("un échec ne consomme qu'UNE tentative : rien ne reste en attente sans exécutant", async () => {
    const h = await harness({ fails: "boom" });
    await h.automation.run(h.rule.id);
    const job = h.jobs.list()[0];
    expect(job?.status, "définitivement échoué, jamais « pending » pour personne").toBe("failed");
    expect(job?.attempts).toBe(1);
    expect(h.jobs.list("pending")).toHaveLength(0);
  });
});

describe("H7 — `run()` ne dit plus « ok » sur un échec", () => {
  it("répond ok:false avec la raison quand l'action échoue", async () => {
    const h = await harness({ fails: "boom" });
    const r = await h.automation.run(h.rule.id);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("boom");
  });

  it("répond ok:true (et dit combien d'actions) quand tout se passe bien", async () => {
    const h = await harness();
    const r = await h.automation.run(h.rule.id);
    expect(r).toEqual({ ok: true, summary: "Règle « h » exécutée (1 action(s))" });
  });

  it("une règle introuvable ou désactivée reste un refus explicite", async () => {
    const h = await harness();
    expect((await h.automation.run("inconnue")).ok).toBe(false);
    h.automation.update(h.rule.id, { enabled: false });
    expect((await h.automation.run(h.rule.id)).summary).toBe("Règle désactivée");
  });
});