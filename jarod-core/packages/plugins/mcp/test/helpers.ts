import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach } from "vitest";
import type {} from "../src/index.js";

export { tempDir };

/** `makeCore` → kernel réel jusqu'à plugin-mcp (sans `init()` : aucun serveur démarré tout seul). */
export async function makeCore() {
  const app = await bootApp({
    storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] },
    memory: {},
    llm: {},
    skills: {},
    rag: {},
    tools: {},
    mcp: { autoSync: false },
  });
  return { app, mcp: app.mcp, tools: app.tools.registry, settings: app.storage.settings };
}

afterEach(cleanup);
