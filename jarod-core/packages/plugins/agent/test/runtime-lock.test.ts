// Portage de packages/core/test/runtime-lock.test.ts (rév. 2e180305).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRuntimeLock,
  RUNTIME_LOCK_FILE,
  RuntimeLockError,
  readRuntimeLock,
} from "../src/runtime-lock.js";
import { makeCore, tempDir, testKeys } from "./helpers.js";

describe("runtime lock", () => {
  it("is taken by init() and released by dispose()", async () => {
    const dir = tempDir();
    // Kernel : `init()` = le démarrage des plugins (le verrou est pris par plugin-agent).
    const core = await makeCore({ dataDir: dir, keyStores: [testKeys], runtimeMode: "headless" });
    expect(readRuntimeLock(dir)).toMatchObject({ pid: process.pid, mode: "headless" });
    await core.dispose();
    expect(existsSync(join(dir, RUNTIME_LOCK_FILE))).toBe(false);
  });

  it("refuses a live holder, takes over a dead one or an unreadable file", () => {
    const dir = tempDir();
    const path = join(dir, RUNTIME_LOCK_FILE);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, mode: "serve", startedAt: 1 }));
    expect(() => acquireRuntimeLock(dir, "desktop")).toThrow(RuntimeLockError);
    try {
      acquireRuntimeLock(dir, "desktop");
    } catch (e) {
      expect((e as RuntimeLockError).holder).toMatchObject({ pid: process.ppid, mode: "serve" });
      expect((e as Error).message).toMatch(/serveur jarod serve/);
    }

    writeFileSync(path, JSON.stringify({ pid: 2_147_483_000, mode: "serve", startedAt: 1 }));
    const release = acquireRuntimeLock(dir, "desktop");
    expect(readRuntimeLock(dir)?.pid).toBe(process.pid);

    // Release only removes the file while it still names this process.
    writeFileSync(path, JSON.stringify({ pid: process.ppid, mode: "serve", startedAt: 2 }));
    release();
    expect(readRuntimeLock(dir)?.pid).toBe(process.ppid);

    writeFileSync(path, "pas du json");
    acquireRuntimeLock(dir, "serve")();
    expect(existsSync(path)).toBe(false);
  });

  it("makes a second process's init() fail instead of running the bots twice", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, RUNTIME_LOCK_FILE), JSON.stringify({ pid: process.ppid, mode: "serve", startedAt: 1 }));
    // Kernel : le démarrage échoue (et libère ce qu'il avait ouvert) au lieu de `init()`.
    await expect(makeCore({ dataDir: dir, keyStores: [testKeys] })).rejects.toThrow(RuntimeLockError);
    // The other process's lock is untouched.
    expect(readRuntimeLock(dir)?.pid).toBe(process.ppid);
  });
});
