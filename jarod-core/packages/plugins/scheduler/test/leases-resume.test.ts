/**
 * V-17 — baux et reprise des tâches longues.
 *
 * 1. Plantage : un noyau A lance une tâche planifiée qui ne finit pas, puis « meurt » (jamais arrêté proprement) ; un noyau B s'ouvre
 *    sur la MÊME base. Avant V-17, le tir était clos « interrompu par un arrêt » et attendait l'occurrence suivante. Désormais il est
 *    repris une fois, dans sa conversation, prévenu ; le prochain tir de l'horaire n'est pas touché.
 * 2. Tâche longue vivante : tant que l'exécutant donne signe de vie, ni la borne ni la file ne la déclarent bloquée ; muette, elle
 *    l'est au bout du délai ; vivante au-delà du plafond absolu, elle est arrêtée aussi.
 */
import { bootApp, tempDir } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { JobsService } from "../src/jobs.js";
import { INTERRUPTED, RESUME_NOTE, Scheduler } from "../src/scheduler.js";
import { makeCore, testKeys } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function crashMidRun(dataDir: string) {
  const a = await bootApp({ storage: { dataDir, keyStores: [testKeys] }, scheduler: { autoStart: false } });
  a.on("schedule/run", () => new Promise(() => {})); // ne rend jamais la main
  const s = a.scheduler.save({ name: "Analyse longue", prompt: "Analyse tout le dépôt", spec: { kind: "interval", minutes: 60 } });
  void a.scheduler.runNow(s.id);
  await sleep(50);
  const job = a.jobs.list().find((j) => j.kind === "schedule")!;
  expect(job.status).toBe("running");
  expect(job.leaseUntil).toBeGreaterThan(Date.now());
  return { a, s, nextRun: a.scheduler.get(s.id)!.nextRun };
}

async function reopen(dataDir: string) {
  const b = await bootApp({ storage: { dataDir, keyStores: [testKeys] }, scheduler: { autoStart: false } });
  const prompts: string[] = [];
  b.on("schedule/run", (sch) => {
    prompts.push(sch.prompt);
    return { sessionId: sch.sessionId ?? "s", ok: true, summary: "terminé" };
  });
  return { b, prompts };
}

describe("V-17 — reprise après un plantage", () => {
  it("le tir interrompu est repris une fois, prévenu, dans sa conversation ; le prochain tir de l'horaire ne bouge pas", async () => {
    const dataDir = tempDir();
    const { s, nextRun } = await crashMidRun(dataDir);
    const { b, prompts } = await reopen(dataDir);
    // `recover` (au démarrage du plugin) l'a remis en attente, avec la raison.
    expect(b.jobs.list().find((j) => j.kind === "schedule")).toMatchObject({ status: "pending", lastError: INTERRUPTED });

    expect(b.scheduler.resumeInterrupted()).toBe(1);
    await sleep(50);
    expect(prompts).toEqual([`${RESUME_NOTE}\n\nAnalyse tout le dépôt`]);
    expect(b.jobs.list().find((j) => j.kind === "schedule")).toMatchObject({ status: "done", result: "ok" });
    expect(b.scheduler.get(s.id)).toMatchObject({ nextRun, lastStatus: "ok" });
    // Rien à reprendre deux fois.
    expect(b.scheduler.resumeInterrupted()).toBe(0);
  });

  it("interrompu depuis plus de 24 h : clos, pas repris ; horaire retiré entre-temps : reprise abandonnée avec la raison", async () => {
    const old = tempDir();
    const first = await crashMidRun(old);
    first.a.storage.db.run("UPDATE jobs SET started_at = ? WHERE kind = 'schedule'", Date.now() - 25 * 3_600_000);
    const late = await reopen(old);
    expect(late.b.jobs.list().find((j) => j.kind === "schedule")).toMatchObject({ status: "failed", lastError: INTERRUPTED });
    expect(late.b.scheduler.resumeInterrupted()).toBe(0);

    const gone = tempDir();
    const second = await crashMidRun(gone);
    second.a.storage.db.run("DELETE FROM schedules");
    const after = await reopen(gone);
    expect(after.b.scheduler.resumeInterrupted()).toBe(0);
    expect(after.b.jobs.list().find((j) => j.kind === "schedule")).toMatchObject({ status: "failed", lastError: expect.stringMatching(/horaire retiré/) });
    expect(after.prompts).toEqual([]);
  });
});

describe("V-17 — une tâche longue qui travaille n'est pas coupée", () => {
  async function setup(stalledAfterMs: number, runner: (beat: () => void) => Promise<{ sessionId: string; ok: boolean; summary: string }>) {
    const core = await makeCore();
    const jobs = new JobsService({ db: core.db, stalledAfterMs });
    const scheduler = new Scheduler(core.db, (_s, beat) => runner(beat ?? (() => {})));
    scheduler.attachJobs(jobs);
    const s = scheduler.save({ name: "Longue", prompt: "travaille", spec: { kind: "interval", minutes: 60 } });
    return { core, jobs, scheduler, s };
  }

  it("vivante (signe de vie toutes les 20 ms) pendant 5× le délai : terminée « ok », et la file ne l'a jamais requalifiée", async () => {
    const { jobs, scheduler, s } = await setup(60, async (beat) => {
      for (let i = 0; i < 15; i++) {
        beat();
        expect(jobs.requalifyStalled()).toBe(0);
        await sleep(20);
      }
      return { sessionId: "x", ok: true, summary: "fini" };
    });
    await scheduler.runNow(s.id);
    expect(scheduler.get(s.id)!.lastStatus).toBe("ok");
    expect(jobs.list().find((j) => j.kind === "schedule")).toMatchObject({ status: "done" });
  });

  it("muette : « délai dépassé (… sans signe de vie) » au bout du délai", async () => {
    const { scheduler, s } = await setup(60, () => new Promise(() => {}));
    await scheduler.runNow(s.id);
    expect(scheduler.get(s.id)!.lastStatus).toMatch(/délai dépassé \(0 s sans signe de vie\)/);
  });

  it("vivante au-delà du plafond absolu : arrêtée quand même", async () => {
    const { scheduler, s } = await setup(60, async (beat) => {
      for (;;) {
        beat();
        await sleep(15);
      }
    });
    scheduler.maxRunMs = 150;
    await scheduler.runNow(s.id);
    expect(scheduler.get(s.id)!.lastStatus).toMatch(/durée maximale atteinte/);
  });

  it("la file respecte le bail : une exécution prise il y a longtemps mais au bail encore valide n'est pas requalifiée", async () => {
    const core = await makeCore();
    const jobs = new JobsService({ db: core.db, stalledAfterMs: 1_000 });
    const { job } = jobs.enqueue({ kind: "x", payload: {} });
    const t0 = Date.now();
    jobs.claim(job.id, t0 - 10_000, 1_000);
    expect(jobs.renew(job.id, t0)).toBe(true);
    expect(jobs.requalifyStalled(t0 + 500)).toBe(0);
    expect(jobs.requalifyStalled(t0 + 1_500)).toBe(1);
    expect(jobs.renew(job.id, t0 + 2_000)).toBe(false);
  });
});
