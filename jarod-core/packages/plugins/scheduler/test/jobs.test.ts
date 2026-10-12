// Portage de packages/core/test/jobs.test.ts (rév. 2e180305), intégral.
import { describe, expect, it } from "vitest";
import { JobsService } from "../src/jobs.js";
import { makeCore } from "./helpers.js";

async function setup(now = 1_000) {
  const core = await makeCore();
  const clock = { value: now };
  const jobs = new JobsService({ db: core.db, now: () => clock.value, backoffMs: (attempt) => attempt * 1000 });
  return { jobs, clock, core };
}

describe("file durable", () => {
  it("met une exécution en file, prête tout de suite", async () => {
    const { jobs } = await setup();
    const { job, created } = jobs.enqueue({ kind: "prompt", payload: { text: "salut" } });
    expect(created).toBe(true);
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(jobs.due()).toHaveLength(1);
  });

  it("la même clé ne crée pas une seconde exécution, et elle le dit", async () => {
    const { jobs } = await setup();
    const first = jobs.enqueue({ kind: "prompt", idempotencyKey: "tour-1" });
    const again = jobs.enqueue({ kind: "prompt", idempotencyKey: "tour-1" });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(jobs.list()).toHaveLength(1);
  });

  it("une exécution datée du futur n'est pas due maintenant", async () => {
    const { jobs, clock } = await setup();
    jobs.enqueue({ kind: "prompt", dueAt: 5_000 });
    expect(jobs.due()).toHaveLength(0);
    clock.value = 5_001;
    expect(jobs.due()).toHaveLength(1);
  });

  it("une exécution ne peut pas être prise deux fois", async () => {
    const { jobs } = await setup();
    const { job } = jobs.enqueue({ kind: "prompt" });
    const claimed = jobs.claim(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    // La seconde prise échoue, et elle le dit au lieu de relancer une exécution en double.
    expect(jobs.claim(job.id)).toBeNull();
  });

  it("un échec sous le plafond revient en attente, avec un délai plus long", async () => {
    const { jobs, clock } = await setup();
    const { job } = jobs.enqueue({ kind: "prompt", maxAttempts: 3 });
    jobs.claim(job.id);
    const first = jobs.fail(job.id, "réseau");
    expect(first.willRetry).toBe(true);
    expect(first.job?.status).toBe("pending");
    expect(first.job?.lastError).toBe("réseau");
    expect(first.job?.dueAt).toBe(clock.value + 1000);

    clock.value += 1000;
    jobs.claim(job.id);
    const second = jobs.fail(job.id, "réseau encore");
    expect(second.job?.dueAt).toBe(clock.value + 2000);
  });

  it("au plafond, l'exécution est parquée en échec avec son erreur — jamais perdue, jamais en boucle", async () => {
    const { jobs } = await setup();
    const { job } = jobs.enqueue({ kind: "prompt", maxAttempts: 2 });
    jobs.claim(job.id);
    jobs.fail(job.id, "erreur 1");
    jobs.claim(job.id);
    const last = jobs.fail(job.id, "erreur 2");
    expect(last.willRetry).toBe(false);
    expect(last.job?.status).toBe("failed");
    expect(last.job?.lastError).toBe("erreur 2");
    expect(jobs.due()).toHaveLength(0);
  });

  it("ce qui était en cours à l'arrêt revient en attente, et on dit combien", async () => {
    const { jobs } = await setup();
    const a = jobs.enqueue({ kind: "prompt" });
    const b = jobs.enqueue({ kind: "prompt" });
    const c = jobs.enqueue({ kind: "prompt" });
    jobs.claim(a.job.id);
    jobs.claim(b.job.id);
    jobs.complete(c.job.id);

    // C'est le trou du planificateur : sans reprise, ces deux-là restaient « running » à jamais.
    expect(jobs.recover()).toBe(2);
    expect(jobs.list("running")).toHaveLength(0);
    expect(jobs.list("pending")).toHaveLength(2);
    expect(jobs.get(a.job.id)?.lastError).toMatch(/interrompu/);
    // Le travail terminé n'est pas ressuscité.
    expect(jobs.get(c.job.id)?.status).toBe("done");
  });

  it("compte ce qui attend, tourne, réussit et échoue", async () => {
    const { jobs } = await setup();
    jobs.enqueue({ kind: "prompt" });
    const running = jobs.enqueue({ kind: "prompt" });
    jobs.claim(running.job.id);
    expect(jobs.stats()).toEqual({ pending: 1, running: 1, done: 0, failed: 0 });
  });

  it("rend les exécutions RÉCENTES sous une borne, sans tirer toute la table", async () => {
    const { jobs, clock } = await setup();
    // Le temps avance : sans cela les cinq exécutions seraient créées à la même milliseconde et
    // « la plus récente » n'aurait aucun sens.
    const ids = ["a", "b", "c", "d", "e"].map((kind) => {
      const enfile = jobs.enqueue({ kind });
      clock.value += 1_000;
      return enfile.job.id;
    });

    const borne = jobs.recent(2);
    expect(borne.map((j) => j.id)).toEqual([ids[4], ids[3]]);
    // L'inventaire complet, lui, n'a pas bougé : la borne est une lecture, pas une purge.
    expect(jobs.list()).toHaveLength(5);
  });

  it("une borne nulle ou absurde ne rend rien plutôt que de tout rendre", async () => {
    const { jobs } = await setup();
    jobs.enqueue({ kind: "prompt" });
    // Une limite à 0 (ou non finie) est un refus de lire, jamais un « pas de limite » : le contraire
    // ferait d'une borne mal calculée la lecture la plus chère possible.
    expect(jobs.recent(0)).toEqual([]);
    expect(jobs.recent(Number.NaN)).toEqual([]);
    expect(jobs.recent(-5)).toEqual([]);
  });
});

