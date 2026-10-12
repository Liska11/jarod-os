// Portage de packages/core/src/services/runtime-lock.ts (rév. 2e180305).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive } from "./supervisor.js";

/**
 * One process at a time runs a profile's background services (messaging bots, scheduler, job queue,
 * webhooks, curator). Two of them on the same data would answer every Telegram message twice and
 * fire every scheduled task twice: the desktop app's single-instance lock cannot see a `jarod serve`
 * daemon, so the guard lives with the data, in `<dataDir>/runtime.lock`, taken by `JarodCore.init()`.
 *
 * Commands that only read or answer one question (`jarod ask`, `mcp`, `acp`) never call `init()`
 * and never take it.
 */

export type RuntimeMode = "desktop" | "headless" | "serve";

export interface RuntimeLock {
  pid: number;
  mode: RuntimeMode;
  startedAt: number;
}

export const RUNTIME_LOCK_FILE = "runtime.lock";

export class RuntimeLockError extends Error {
  constructor(readonly holder: RuntimeLock) {
    super(
      `Ce profil est déjà servi par un autre processus (${describeMode(holder.mode)}, pid ${holder.pid}). ` +
        "Arrêtez-le d'abord (jarod headless stop), ou utilisez un autre profil.",
    );
    this.name = "RuntimeLockError";
  }
}

export const describeMode = (m: RuntimeMode): string =>
  m === "serve" ? "serveur jarod serve" : m === "headless" ? "instance en arrière-plan" : "application de bureau";

export function readRuntimeLock(dataDir: string): RuntimeLock | null {
  try {
    const lock = JSON.parse(readFileSync(join(dataDir, RUNTIME_LOCK_FILE), "utf8")) as RuntimeLock;
    return Number.isInteger(lock?.pid) && lock.pid > 0 ? lock : null;
  } catch {
    return null;
  }
}

/**
 * Takes the lock, or throws `RuntimeLockError` naming the live process that holds it. A lock left
 * by a process that died is taken over. Returns the release function (which only removes the file
 * while it still names this pid).
 */
export function acquireRuntimeLock(dataDir: string, mode: RuntimeMode, pid = process.pid): () => void {
  const path = join(dataDir, RUNTIME_LOCK_FILE);
  const mine: RuntimeLock = { pid, mode, startedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx`: create only if absent, so two processes starting together cannot both win.
      writeFileSync(path, JSON.stringify(mine), { flag: "wx" });
      return () => {
        if (readRuntimeLock(dataDir)?.pid === pid) rmSync(path, { force: true });
      };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      const holder = readRuntimeLock(dataDir);
      if (holder && holder.pid !== pid && isProcessAlive(holder.pid)) throw new RuntimeLockError(holder);
      // Stale (dead holder, unreadable file, or our own pid from a previous core): take it over.
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Impossible de prendre le verrou ${path}`);
}
