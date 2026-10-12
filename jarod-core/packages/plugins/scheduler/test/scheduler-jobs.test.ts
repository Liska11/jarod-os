// Portage de packages/core/test/scheduler-jobs.test.ts (rév. 2e180305), intégral.
import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import { makeCore } from "./helpers.js";

const INSTANT = 1_700_000_000_000;

async function setup() {
  const core = await makeCore();
  const ran: string[] = [];
  // Le runner est le nôtre : ce test porte sur la file, pas sur l'agent, et un vrai tir d'agent
  // rendrait le test lent et dépendant d'un fournisseur.
  const scheduler = new Scheduler(core.db, async (schedule) => {
    ran.push(schedule.id);
    return { sessionId: "session-de-test", ok: true, summary: "fait" };
  });
  scheduler.attachJobs(core.jobs);
  const schedule = scheduler.save({
    name: "veille",
    prompt: "regarde",
    spec: { kind: "interval", minutes: 5 },
    enabled: true,
  });
  return { core, scheduler, ran, schedule };
}

describe("une exécution planifiée passe par la file durable", () => {
  it("écrit l'exécution, la prend, la referme — au lieu de disparaître si l'app s'arrête", async () => {
    const { core, scheduler, ran, schedule } = await setup();
    await scheduler.runNow(schedule.id, INSTANT);

    expect(ran).toEqual([schedule.id]);
    const jobs = core.jobs.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "schedule", status: "done" });
    // La ligne porte de quoi retrouver l'horaire responsable, pas seulement qu'il s'est passé quelque chose.
    expect(core.jobs.get(jobs[0]!.id)?.payload).toMatchObject({ scheduleId: schedule.id, at: INSTANT });
  });

  it("un tick rejoué ne retravaille pas : la ligne ne suffit pas, le travail est la garantie", async () => {
    const { core, scheduler, ran, schedule } = await setup();
    await scheduler.runNow(schedule.id, INSTANT);
    await scheduler.runNow(schedule.id, INSTANT);
    expect(ran).toHaveLength(1);
    expect(core.jobs.list()).toHaveLength(1);
  });

  it("l'instant suivant est un autre travail, pas un doublon", async () => {
    const { core, scheduler, ran, schedule } = await setup();
    await scheduler.runNow(schedule.id, INSTANT);
    await scheduler.runNow(schedule.id, INSTANT + 300_000);
    expect(ran).toHaveLength(2);
    expect(core.jobs.list()).toHaveLength(2);
  });

  it("sans file attachée, le planificateur travaille comme avant", async () => {
    const { core, scheduler, ran, schedule } = await setup();
    // Un hôte qui n'attache rien garde le comportement d'origine : aucune régression, aucun refus.
    const standalone = new Scheduler(core.db, async (s) => {
      ran.push(s.id);
      return { sessionId: "x", ok: true, summary: "ok" };
    });
    await standalone.runNow(schedule.id, INSTANT + 1);
    expect(ran).toEqual([schedule.id]);
    // Rien n'est écrit : sans file, il n'y a pas de file. Le travail, lui, a bien eu lieu.
    expect(core.jobs.list()).toHaveLength(0);
  });
});

