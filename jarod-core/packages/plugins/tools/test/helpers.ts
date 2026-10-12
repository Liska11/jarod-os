import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { type KeyStore, memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach } from "vitest";
import type {} from "../src/index.js";
import type {} from "@jarod/plugin-rag";

export { tempDir };
export const testKeys = memoryKeyStore();

/** `makeCore` (core/test/helpers.ts) → kernel réel storage + memory + llm + skills + tools. */
export async function makeCore(opts: { dataDir?: string; keyStores?: KeyStore[] } = {}) {
  const app = await bootApp({
    storage: { dataDir: opts.dataDir ?? tempDir(), keyStores: opts.keyStores ?? [testKeys] },
    memory: {},
    llm: {},
    skills: {},
    rag: {},
    tools: {},
    permissions: { rules: [] },
  });
  // Provide ctx.approve for ToolsService (ShellApprover) — retourne false (backgroundHooks).
  app.provide("approve", { approve: async () => false });
  return {
    app,
    db: app.storage.db,
    settings: app.storage.settings,
    memory: app.memory.memory,
    rag: app.rag.rag,
    tools: app.tools.registry,
    lsp: app.tools.lsp,
    sshHosts: app.tools.sshHosts,
    dispose: () => shutdown(app),
  };
}

afterEach(cleanup);

export type TestCore = Awaited<ReturnType<typeof makeCore>>;
