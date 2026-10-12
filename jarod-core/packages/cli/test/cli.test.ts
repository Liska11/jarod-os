// Portage de packages/cli/test/cli.test.ts:1-68 (rév. 2e180305). Le bloc « MCP server » (:70-108)
// arrive avec mcp-server.ts (Phase 2).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JarodApp, start, stop } from "@jarod/kernel";
import { secretKeyFor } from "@jarod/plugin-llm";
import { ProfileManager } from "@jarod/plugin-persona";
import type {} from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataRoot, openCore } from "../src/context.js";
import { parseArgs } from "../src/main.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-cli-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("arguments", () => {
  it("parses commands, flags, values and aliases", () => {
    expect(parseArgs(["ask", "-c", "--model", "openai/gpt-x", "bonjour", "toi"])).toEqual({
      command: "ask",
      positional: ["bonjour", "toi"],
      flags: { continue: true, model: "openai/gpt-x" },
    });
    expect(parseArgs(["memory", "add", "--profile=travail", "preference", "court"]).flags.profile).toBe("travail");
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["ask", "--", "--pas-un-flag"]).positional).toEqual(["--pas-un-flag"]);
  });

  it("locates the desktop data folder per platform", () => {
    expect(defaultDataRoot({ JAROD_HOME: "/x" }, "linux", "/home/a")).toBe("/x");
    expect(defaultDataRoot({ APPDATA: "C:\\U\\AppData\\Roaming" }, "win32", "C:\\U")).toBe(
      join("C:\\U\\AppData\\Roaming", "Jarod-One", "data"),
    );
    expect(defaultDataRoot({}, "darwin", "/Users/a")).toBe(
      join("/Users/a", "Library", "Application Support", "Jarod-One", "data"),
    );
    expect(defaultDataRoot({}, "linux", "/home/a")).toBe(join("/home/a", ".config", "Jarod-One", "data"));
  });
});

describe("context", () => {
  it("opens the active profile and falls back to environment API keys", { timeout: 60_000 }, async () => {
    const root = temp();
    const pm = new ProfileManager(root);
    pm.create("travail");
    pm.setActive("travail");
    // A key stored by the desktop app with the OS keychain cannot be read by the CLI.
    // (`new JarodCore({ dataDir, cipher })` → kernel avec plugin-storage, mêmes magasins de clé.)
    const desktop = new JarodApp({
      plugins: {
        storage: { dataDir: pm.dirFor("travail"), cipher: { encrypt: (s: string) => `ss:${s}`, decrypt: (s: string) => s.slice(3) } },
      },
    });
    const started = await start(desktop);
    (desktop as unknown as { storage: { settings: { setSecret(k: string, v: string): void } } }).storage.settings.setSecret(
      secretKeyFor("openai"),
      "desktop-key",
    );
    await stop(started);

    const { core, profile } = await openCore({ env: { JAROD_HOME: root, ANTHROPIC_API_KEY: "env-key" } });
    expect(profile).toBe("travail");
    expect(core.settings.getSecret(secretKeyFor("anthropic"))).toBe("env-key");
    expect(core.settings.getSecret(secretKeyFor("openai"))).toBeUndefined();
    expect(core.providers.list().find((p) => p.id === "anthropic")?.configured).toBe(true);
    await core.dispose();
    await expect(openCore({ env: { JAROD_HOME: root }, profile: "inconnu" })).rejects.toThrow(/inconnu/);
  });
});
