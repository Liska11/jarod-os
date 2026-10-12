import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach } from "vitest";
import type {} from "../src/index.js";

export { tempDir };
export const testKeys = memoryKeyStore();

/** `makeCore` (core/test/helpers.ts) → kernel réel storage + memory. */
export async function makeCore() {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [testKeys] }, memory: {} });
  return {
    app,
    db: app.storage.db,
    settings: app.storage.settings,
    memory: app.memory.memory,
    userProfile: app.memory.userProfile,
    portability: app.memory.portability,
    annotations: app.memory.annotations,
    events: app.storage.events,
  };
}

afterEach(cleanup);
