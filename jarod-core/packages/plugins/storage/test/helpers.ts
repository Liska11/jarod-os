import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach } from "vitest";
import { memoryKeyStore } from "../src/dbkey.js";

export { tempDir };

/** Shared in-memory key store: fast, and keys survive re-opening a core on the same folder. */
export const testKeys = memoryKeyStore();

/** `makeCore` (core/test/helpers.ts) → un kernel réel avec plugin-storage ; `core.db`, `core.events`… */
export async function makeCore(storage: Record<string, unknown> = {}) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [testKeys], ...storage } });
  return Object.assign(app.storage, { app });
}

afterEach(cleanup);
