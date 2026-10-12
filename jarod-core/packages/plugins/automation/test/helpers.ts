import type { ScheduleDto } from "@jarod/contracts";
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach } from "vitest";

export { tempDir };
export const testKeys = memoryKeyStore();

/**
 * `makeCore` → kernel réel storage + scheduler + automation.
 *
 * `trackScheduleRun` : l'exécutant `schedule/run` devient asynchrone (20 ms) et tient un compteur
 * de CONCURRENCE exposé par `maxActive()`. `cordis.serial` s'arrête au premier callback qui rend
 * une valeur, c'est donc CET écouteur qui doit porter la sonde (un second écouteur ne serait
 * jamais appelé) — AU3 s'en sert pour détecter des actions agent lancées en parallèle (AM4).
 */
export async function makeCore(
  opts: {
    dataDir?: string;
    keyStores?: ReturnType<typeof memoryKeyStore>[];
    trackScheduleRun?: boolean;
    /** Le tour agent rend ok:false avec ce résumé (AV2-007 : l'échec d'une action doit se voir). */
    agentFails?: string;
  } = {},
) {
  const app = await bootApp({
    storage: { dataDir: opts.dataDir ?? tempDir(), keyStores: opts.keyStores ?? [testKeys] },
    scheduler: { autoStart: false },
    automation: {},
    tools: {},
    memory: {},
    llm: {},
    skills: {},
    skillsHub: {},
    rag: {},
    permissions: { rules: [] },
  });
  // Exécutant schedule/run pour les tests (premier appelé : porteur de la sonde de concurrence)
  let active = 0;
  let peak = 0;
  const schedules: ScheduleDto[] = [];
  app.on("schedule/run", async (s) => {
    schedules.push(s);
    if (opts.agentFails) return { sessionId: `session-${s.id}`, ok: false, summary: opts.agentFails };
    if (opts.trackScheduleRun) {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    }
    return { sessionId: `session-${s.id}`, ok: true, summary: "ok" };
  });
  return {
    app,
    /** Pic de concurrence observé sur `schedule/run` (0 si `trackScheduleRun` désactivé). */
    maxActive: () => peak,
    /** Les `ScheduleDto` reçus par l'exécutant `schedule/run`, dans l'ordre. */
    schedules,
    db: app.storage.db,
    settings: app.storage.settings,
    jobs: app.jobs,
    scheduler: app.scheduler,
    automation: app.automation,
    storage: app.storage,
    dispose: () => shutdown(app),
  };
}

afterEach(cleanup);

export type TestCore = Awaited<ReturnType<typeof makeCore>>;