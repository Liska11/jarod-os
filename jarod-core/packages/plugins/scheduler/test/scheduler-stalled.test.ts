/**
 * §3.6-2 de l'audit — `running.delete(id)` n'était atteint que si le runner se réglait (`finally`) :
 * un runner qui ne rend jamais la main laissait l'identifiant en place et l'horaire ne repartait plus
 * JAMAIS, alors que `jobs.ts` sait déjà requalifier une exécution bloquée. La libération se fait
 * maintenant passé le même délai que la file.
 */
import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler.js";
import { makeCore } from "./helpers.js";

const INSTANT = 1_700_000_000_000;
const STALLED = 15 * 60_000;

/** Un planificateur sur la base d'un vrai noyau, dont le runner est piloté par le test. */
async function setup(runner: (id: string) => Promise<{ sessionId: string; ok: boolean; summary: string }>) {
  const core = await makeCore();
  const ran: string[] = [];
  const scheduler = new Scheduler(core.db, async (s) => {
    ran.push(s.id);
    return runner(s.id);
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

describe("§3.6-2 — un horaire ne reste pas « en cours » pour toujours", () => {
  it("passé le délai de la file, l'horaire bloqué repart au tick suivant", async () => {
    let hangs = true;
    const { scheduler, ran, schedule } = await setup(() =>
      hangs ? new Promise(() => {}) : Promise.resolve({ sessionId: "s", ok: true, summary: "fait" }),
    );
    expect(scheduler.stalledAfterMs, "le délai est celui de la file").toBe(STALLED);

    void scheduler.runNow(schedule.id, INSTANT); // ne rend jamais la main
    expect(ran).toEqual([schedule.id]);

    // Avant le délai, l'exécution en vol bloque encore l'horaire : on ne double pas un tir.
    await scheduler.tick(INSTANT + 5 * 60_000);
    expect(ran, "avant le délai, l'horaire reste bloqué").toEqual([schedule.id]);

    hangs = false;
    await scheduler.tick(INSTANT + STALLED);
    expect(ran, "passé le délai, l'horaire repart").toEqual([schedule.id, schedule.id]);
  });

  it("sans file attachée, le délai par défaut est celui de jobs.ts", async () => {
    const core = await makeCore();
    const scheduler = new Scheduler(core.db, async (s) => ({ sessionId: s.id, ok: true, summary: "ok" }));
    expect(scheduler.stalledAfterMs).toBe(STALLED);
  });

  it("une exécution bloquée puis reprise n'est pas libérée par l'ancienne qui se règle après coup", async () => {
    const first: { release?: () => void } = {};
    let call = 0;
    const { scheduler, ran, schedule } = await setup(() => {
      call++;
      if (call === 1) {
        return new Promise((resolve) => {
          first.release = () => resolve({ sessionId: "1", ok: true, summary: "ok" });
        });
      }
      return new Promise(() => {}); // le second tir reste en vol, lui aussi
    });

    void scheduler.runNow(schedule.id, INSTANT);
    // Au-delà du délai : la purge libère l'horaire, un nouveau tir part et reste en vol.
    void scheduler.tick(INSTANT + STALLED);
    expect(ran).toHaveLength(2);

    // L'ancienne exécution se règle enfin : elle ne doit pas libérer la place de la nouvelle.
    first.release?.();
    await new Promise((r) => setTimeout(r, 0));

    // Au prochain tir dû (5 min plus tard, donc bien avant les 15 min de la nouvelle exécution),
    // rien ne doit repartir : la place appartient toujours au second tir. On n'attend pas le tick,
    // puisque le second tir est justement en vol et ne rend jamais la main.
    void scheduler.tick(INSTANT + STALLED + 5 * 60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(ran, "la place de la nouvelle exécution n'a pas été libérée par l'ancienne").toHaveLength(2);
  });
});
