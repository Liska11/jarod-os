/**
 * M7 (audit v4 § 1) — une exécution qui ne rend jamais la main ne doit figer NI la file NI le runner.
 *
 * Avant correctif : `claim()` posait `running` sans instant de prise, `due()` ne regardait que `pending`, et
 * `recover()` ne s'exécutait qu'au démarrage. Un `onRun` bloqué laissait donc la ligne `running` pour
 * toujours — invisible de la file — et le booléen `running` du runner restait à vrai : plus AUCUNE tâche
 * webhook ne passait, jusqu'au redémarrage de l'application.
 */
import { describe, expect, it } from "vitest";
import { JobsService } from "../src/jobs.js";
import { WebhookRunner } from "../src/webhook-runner.js";
import { makeCore } from "./helpers.js";

/** Une file sur la base d'un vrai noyau, avec une horloge que le test fait avancer. */
async function queue(opts: { stalledAfterMs?: number } = {}) {
  const core = await makeCore();
  let t = 1_700_000_000_000;
  const jobs = new JobsService({
    db: core.db,
    now: () => t,
    ...(opts.stalledAfterMs !== undefined ? { stalledAfterMs: opts.stalledAfterMs } : {}),
  });
  return { core, jobs, now: () => t, at: (v: number) => { t = v; } };
}

describe("M7 — la file requalifie une exécution bloquée", () => {
  it("`claim` horodate la prise, et `due()` requalifie au-delà du délai", async () => {
    const q = await queue({ stalledAfterMs: 60_000 });
    const { job } = q.jobs.enqueue({ kind: "webhook", ref: "hook-1", payload: { a: 1 }, dueAt: q.now() });
    const claimed = q.jobs.claim(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt, "l'instant de la prise est gardé").toBe(q.now());

    q.at(q.now() + 120_000); // au-delà du délai : l'exécution est bloquée
    q.jobs.due();

    const after = q.jobs.get(job.id);
    expect(after?.status, "elle repart en attente (sous son plafond de tentatives)").toBe("pending");
    expect(after?.lastError).toMatch(/bloquée/);
    expect(after?.startedAt, "la prise est effacée").toBeNull();
  });

  it("au plafond de tentatives, une exécution bloquée est parquée en échec, pas remise en boucle", async () => {
    const q = await queue({ stalledAfterMs: 60_000 });
    const { job } = q.jobs.enqueue({ kind: "webhook", payload: {}, dueAt: q.now(), maxAttempts: 1 });
    q.jobs.claim(job.id); // attempts = 1 = plafond
    q.at(q.now() + 120_000);
    q.jobs.due();
    expect(q.jobs.get(job.id)?.status).toBe("failed");
    expect(q.jobs.get(job.id)?.lastError).toMatch(/bloquée/);
  });

  it("une exécution en cours DEPUIS MOINS que le délai n'est pas touchée", async () => {
    const q = await queue({ stalledAfterMs: 60_000 });
    const { job } = q.jobs.enqueue({ kind: "webhook", payload: {}, dueAt: q.now() });
    q.jobs.claim(job.id);
    q.at(q.now() + 30_000);
    q.jobs.due();
    expect(q.jobs.get(job.id)?.status).toBe("running");
  });

  it("`ref` est enregistré et relu (le lien n'est plus dans le JSON du payload)", async () => {
    const q = await queue();
    const { job } = q.jobs.enqueue({ kind: "automation", ref: "regle-42", payload: { autre: "chose" }, dueAt: q.now() });
    expect(job.ref).toBe("regle-42");
    expect(q.jobs.get(job.id)?.ref).toBe("regle-42");
  });
});

describe("M7 — un `onRun` qui ne rend jamais la main ne fige plus le runner", () => {
  it("`tick()` rend la main (délai dépassé) et la tâche suivante passe au tick d'après", async () => {
    const q = await queue();
    const blocked = q.jobs.enqueue({ kind: "webhook", ref: "bloque", payload: {}, dueAt: q.now() }).job;

    const seen: string[] = [];
    const runner = new WebhookRunner({
      jobs: q.jobs,
      runTimeoutMs: 50,
      onRun: (job) => {
        seen.push(String(job.ref));
        // Il ne rend JAMAIS la main : c'est exactement ce que faisait un handler bloqué.
        return new Promise<void>(() => {});
      },
    });

    const n1 = await Promise.race([runner.tick(), new Promise<number>((r) => setTimeout(() => r(-1), 3000))]);
    expect(n1, "`tick()` ne doit pas rester en vol").not.toBe(-1);
    expect(n1, "l'exécution bloquée n'est pas comptée comme réussie").toBe(0);
    expect(q.jobs.get(blocked.id)?.lastError).toMatch(/délai dépassé/);
    expect(q.jobs.get(blocked.id)?.status, "jamais « running » pour toujours").not.toBe("running");

    // Le runner n'est pas figé : le tick suivant prend une NOUVELLE tâche (l'ancienne attend son délai).
    const next = q.jobs.enqueue({ kind: "webhook", ref: "suivant", payload: {}, dueAt: q.now() }).job;
    const runner2 = new WebhookRunner({ jobs: q.jobs, runTimeoutMs: 50, onRun: (job) => (seen.push(String(job.ref)), Promise.resolve()) });
    const n2 = await runner2.tick();
    expect(n2, "la tâche suivante est bien exécutée").toBe(1);
    expect(q.jobs.get(next.id)?.status).toBe("done");
    expect(seen).toContain("suivant");
  });
});