import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach } from "vitest";
import type {} from "../src/index.js";

export { tempDir };
export const testKeys = memoryKeyStore();

/** `makeCore` (core/test/helpers.ts) → kernel réel storage + llm ; `core.settings`, `core.providers`… */
export async function makeCore() {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [testKeys] }, llm: {} });
  return { app, db: app.storage.db, settings: app.storage.settings, providers: app.llm.providers, routing: app.llm.routing };
}

afterEach(cleanup);
