/**
 * R3.5 — l'exécution d'un horaire est BORNÉE, et un arrêt libère ce qui est en vol.
 *
 * §3.6-2 (M7) libérait la place « au tick suivant » seulement : entre-temps le runner continuait, et
 * un runner qui ne rend jamais la main n'était jamais arrêté. Ici la borne est celle de la file : le
 * tir est déclaré terminé (statut écrit, place libérée) et le retour tardif du runner ne réécrit rien,
 * parce que la course est déjà perdue. `stop()` libère aussi, plutôt que de laisser des exécutions
 * « en cours » dans un planificateur qui ne tourne plus.
 */
import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import { makeCore } from "./helpers.js";

const INSTANT = 1_700_000_000_000;
/** La borne est celle de la file (`stalledAfterMs`) : on l'attache courte pour ne pas attendre 15 minutes. */
const BOUND = 40;

interface Run {
  sessionId: string;
  ok: boolean;
  summary: string;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Laisse les bornes en vol se déclencher AVANT la fermeture de la base du test : sans cela, une borne
 * qui s'applique après le test écrirait dans une base déjà fermée.
 */
const drain = async (scheduler: Scheduler) => {
  scheduler.stop();
  await new Promise((r) => setTimeout(r, BOUND + 20));
};

/** Un planificateur sur la base d'un vrai noyau, dont le runner est piloté par le test. */
async function setup(runner: (id: string) => Promise<Run>) {
  const core = await makeCore();
  const ran: string[] = [];
  const scheduler = new Scheduler(core.db, async (s) => {
    ran.push(s.id);
    return runner(s.id);
  });
  // La borne est la même que celle de la file : on raccourcit la vraie file plutôt que d'en simuler
  // une fausse, pour que `enqueue`/`claim`/`complete` soient bien ceux du produit.
  Object.defineProperty(core.jobs, "stalledAfterMs", { value: BOUND, configurable: true });
  scheduler.attachJobs(core.jobs);
  const schedule = scheduler.save({
    name: "veille",
    prompt: "regarde",
    spec: { kind: "interval", minutes: 5 },
    enabled: true,
  });
  return { core, scheduler, ran, schedule };
}

describe("R3.5 — une exécution qui ne rend jamais la main est bornée", () => {
  it("passé la borne, le statut est écrit et la place est libérée", async () => {
    const { scheduler, ran, schedule } = await setup(() => new Promise<Run>(() => {}));

    // Borné : `runNow` rend la main à l'échéance au lieu d'attendre un runner qui ne se règle jamais.
    await scheduler.runNow(schedule.id, INSTANT);
    expect(scheduler.get(schedule.id)?.lastStatus).toMatch(/^erreur : délai dépassé/);

    // La place est libre : le tir suivant (dû 5 minutes plus tard) repart.
    await scheduler.tick(INSTANT + 5 * 60_000);
    expect(ran, "la borne n'a pas condamné l'horaire").toHaveLength(2);
    await drain(scheduler);
  });

  it("le retour tardif du runner borné n'écrit plus session_id ni un statut de succès", async () => {
    const first: { release?: (r: Run) => void } = {};
    let call = 0;
    const { scheduler, schedule } = await setup(() => {
      call++;
      if (call === 1) return new Promise<Run>((resolve) => (first.release = resolve));
      return new Promise<Run>(() => {}); // le second tir reste en vol, lui aussi
    });

    void scheduler.runNow(schedule.id, INSTANT);
    await vi.waitFor(() => expect(scheduler.get(schedule.id)?.lastStatus).toMatch(/^erreur : délai dépassé/));
    // Le tir suivant reprend la place (l'horaire est dû 5 minutes après INSTANT).
    void scheduler.tick(INSTANT + 5 * 60_000);
    await settle();
    expect(scheduler.get(schedule.id)?.lastStatus, "le second tir n'a pas encore d'issue").toMatch(/^erreur : délai dépassé/);

    // Le premier runner se réveille enfin : sa course est perdue, il ne doit rien réécrire.
    first.release?.({ sessionId: "1", ok: true, summary: "ok" });
    await settle();
    expect(scheduler.get(schedule.id)?.sessionId, "le retour tardif n'a pas écrit session_id").not.toBe("1");
    expect(scheduler.get(schedule.id)?.lastStatus, "le retour tardif n'a pas écrit un succès").toMatch(/^erreur : délai dépassé/);
    await drain(scheduler);
  });

  it("stop() libère les places en vol : un tick peut repartir sans attendre l'échéance", async () => {
    const { scheduler, ran, schedule } = await setup(() => new Promise<Run>(() => {}));

    void scheduler.runNow(schedule.id, INSTANT);
    await settle();
    expect(ran).toHaveLength(1);

    scheduler.stop();
    await scheduler.tick(INSTANT + 5 * 60_000);
    expect(ran, "l'arrêt a libéré la place").toHaveLength(2);
    await drain(scheduler);
  });
});
