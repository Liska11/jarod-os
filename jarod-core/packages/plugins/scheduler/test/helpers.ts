import { memoryKeyStore } from "@jarod/plugin-storage";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach } from "vitest";

export { tempDir };

export const testKeys = memoryKeyStore();

/**
 * `makeCore` (core/test/helpers.ts) → un kernel réel storage + scheduler. Comme `new JarodCore()`
 * sans `start()`, le tick n'est pas lancé (`autoStart: false`) : le test pilote `tick`/`runNow`.
 * Un exécutant `schedule/run` rend « ok » (l'agent arrive en Phase 1).
 */
export async function makeCore(dataDir = tempDir()) {
  const app = await bootApp({
    storage: { dataDir, keyStores: [testKeys] },
    scheduler: { autoStart: false },
  });
  app.on("schedule/run", (s) => ({ sessionId: `session-${s.id}`, ok: true, summary: "ok" }));
  return { app, db: app.storage.db, settings: app.storage.settings, jobs: app.jobs, scheduler: app.scheduler };
}

afterEach(cleanup);
