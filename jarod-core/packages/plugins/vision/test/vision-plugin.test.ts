// plugin-vision : `ctx.vision` câblé sur llm + rag (core.ts:462-467).
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";

afterEach(cleanup);

describe("plugin-vision", () => {
  it("attend llm et rag, puis décide selon les réglages (défaut : rien à décrire sans modèle configuré)", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, rag: {}, llm: {}, vision: {} });
    expect(app.vision.config()).toEqual({ mode: "auto", provider: "", model: "" });
    expect(app.vision.needed({ provider: "lmstudio", model: "x" })).toBe(false);
    app.storage.settings.set("imageDescription", { mode: "always", provider: "openai", model: "gpt" });
    expect(app.vision.needed({ provider: "anthropic", model: "claude" })).toBe(true);
  });
});
