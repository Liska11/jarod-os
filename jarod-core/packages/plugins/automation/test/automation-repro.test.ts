/**
 * AV2-005 + AV2-006 — verrou repris de `docs/audit-v2-scripts/repro-automation.mts` (constats R4 de
 * l'audit v2), avec un VRAI kernel et une VRAIE base sur disque :
 *
 *  (a) une règle dont le cron n'est PAS dû ne tourne pas — 0 exécution parasite en 3 ticks. L'ancien
 *      code exécutait chaque règle `schedule` à CHAQUE tick de 30 s (le repro : cron annuel ⇒
 *      3 exécutions en 3 ticks) ;
 *  (b) une règle dont le cron est dû tourne UNE fois par échéance, pas une fois par tick ;
 *  (c) l'idempotence SURVIT au redémarrage du processus : elle est portée par
 *      `jobs.idempotency_key` (persisté), plus par un compteur en mémoire. Les échéances déjà payées
 *      ne rejouent pas, et — le défaut d'origine — une échéance NEUVE après redémarrage n'est pas
 *      avalée en silence (le repro : « session 2 : 0 exécution en 3 ticks »).
 */
import { describe, expect, it } from "vitest";
import { makeCore, tempDir, testKeys } from "./helpers.js";

type Core = Awaited<ReturnType<typeof makeCore>>;
const jobsAuto = (core: Core) => core.jobs.list().filter((j) => j.kind === "automation");

/** Recule `created_at` d'UNE PÉRIODE PILE : le cron a alors exactement une échéance passée, aucune future. */
function rendreDue(core: Core, id: string, periodeMs: number): void {
  const now = Date.now();
  core.db.run("UPDATE automation_rules SET created_at = ? WHERE id = ?", Math.floor(now / periodeMs) * periodeMs - periodeMs, id);
}

const AGENT = [{ type: "agent", prompt: "x", mode: "plan" }] as const;
const NOTIFY = [{ type: "notify", title: "T", body: "b" }] as const;

describe("AV2-005 — le cron est interprété, pas ignoré", () => {
  it("cron ANNUEL : 3 ticks ⇒ 0 exécution (l'ancien code en faisait 3)", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys] });
    // Créée à l'instant : la prochaine échéance du 1ᵉʳ janvier est dans le futur, donc rien n'est dû.
    core.automation.create({ name: "annuelle", trigger: { kind: "schedule", cron: "0 0 1 1 *" }, actions: [...AGENT] });
    for (let i = 0; i < 3; i++) expect(await core.automation.tick()).toBe(0);
    expect(jobsAuto(core)).toHaveLength(0);
    await core.dispose();
  });

  it("une échéance due = UN job, et les ticks suivants n'en ajoutent aucun", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys] });
    const rule = core.automation.create({ name: "horaire", trigger: { kind: "schedule", cron: "0 * * * *" }, actions: [...NOTIFY] });
    rendreDue(core, rule.id, 3_600_000);
    expect(await core.automation.tick()).toBe(1);
    expect(await core.automation.tick()).toBe(0);
    expect(await core.automation.tick()).toBe(0);
    expect(jobsAuto(core)).toHaveLength(1);
    expect(jobsAuto(core)[0]).toMatchObject({ status: "done", payload: { ruleId: rule.id, actionIndex: 0 } });
    await core.dispose();
  });
});

describe("AV2-006 — l'idempotence survit au redémarrage du processus", () => {
  it("même base, nouveau processus : rien n'est rejoué, et une échéance NEUVE n'est pas avalée", async () => {
    const dir = tempDir();

    // Session 1 : une échéance payée.
    const un = await makeCore({ dataDir: dir, keyStores: [testKeys] });
    const horaire = un.automation.create({ name: "horaire", trigger: { kind: "schedule", cron: "0 * * * *" }, actions: [...NOTIFY] });
    rendreDue(un, horaire.id, 3_600_000);
    expect(await un.automation.tick()).toBe(1);
    expect(jobsAuto(un)).toHaveLength(1);
    await un.dispose();

    // Session 2 : même base, processus neuf. Le compteur en mémoire est parti : seule la clé
    // persistée (`jobs.idempotency_key`) peut encore retenir l'échéance déjà payée.
    const deux = await makeCore({ dataDir: dir, keyStores: [testKeys] });
    for (let i = 0; i < 3; i++) expect(await deux.automation.tick()).toBe(0);
    expect(jobsAuto(deux)).toHaveLength(1);

    // Une règle NEUVE, due à une échéance que ce processus n'a jamais vue : elle tourne. C'est
    // exactement ce que le compteur en mémoire supprimait en silence (0 en 3 ticks du repro).
    const neuve = deux.automation.create({ name: "neuve", trigger: { kind: "schedule", cron: "0 * * * *" }, actions: [...NOTIFY] });
    rendreDue(deux, neuve.id, 3_600_000);
    expect(await deux.automation.tick()).toBe(1);
    expect(jobsAuto(deux)).toHaveLength(2);
    expect(jobsAuto(deux).map((j) => (j.payload as { ruleId: string }).ruleId).sort()).toEqual([horaire.id, neuve.id].sort());
    await deux.dispose();
  });
});
