// Portage de packages/core/test/settings-memory.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@jarod/plugin-storage";
import { makeCore, tempDir } from "./helpers.js";

describe("settings", () => {
  it("returns defaults and persists patches", async () => {
    const { settings } = await makeCore();
    expect(settings.getAll().activeProvider).toBe(DEFAULT_SETTINGS.activeProvider);
    settings.patch({ language: "en", thinking: false, bogus: 1 } as never);
    expect(settings.get("language")).toBe("en");
    expect(settings.get("thinking")).toBe(false);
    expect("bogus" in settings.getAll()).toBe(false);
  });

  it("encrypts secrets with the injected cipher", async () => {
    const dir = tempDir();
    const cipher = {
      encrypt: (s: string) => `enc:${Buffer.from(s).toString("base64")}`,
      decrypt: (s: string) => Buffer.from(s.slice(4), "base64").toString(),
    };
    const core = await makeCore({ dataDir: dir, cipher });
    core.settings.setSecret("k", "sk-123");
    const stored = core.db.get<{ value: string }>("SELECT value FROM secrets WHERE key = 'k'")!.value;
    expect(stored).not.toContain("sk-123");
    expect(core.settings.getSecret("k")).toBe("sk-123");
    core.settings.setSecret("k", "");
    expect(core.settings.getSecret("k")).toBeUndefined();
    await core.dispose();
  });
});

describe("memory", () => {
  it("adds (deduplicated), searches and ranks relevant memories", async () => {
    const { memory } = await makeCore();
    memory.add("L'utilisateur s'appelle Jarod", "fact");
    memory.add("L'utilisateur s'appelle Jarod", "fact");
    memory.add("Préfère les réponses courtes", "preference");
    memory.add("Travaille sur un projet Electron", "context");
    expect(memory.list()).toHaveLength(3);
    expect(memory.search("electron")[0]?.content).toContain("Electron");
    const rel = memory.relevant("parle-moi de mon projet electron");
    expect(rel.map((m) => m.type)).toContain("preference");
    expect(rel.some((m) => m.content.includes("Electron"))).toBe(true);
  });

  it("updates and deletes", async () => {
    const { memory } = await makeCore();
    const m = memory.add("aime le thé");
    memory.update(m.id, "aime le café", "preference");
    expect(memory.get(m.id)).toMatchObject({ content: "aime le café", type: "preference" });
    expect(memory.search("café")).toHaveLength(1);
    memory.delete(m.id);
    expect(memory.search("café")).toHaveLength(0);
  });
});
