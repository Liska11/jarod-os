// Portage de packages/core/src/services/supervisor.ts (rév. 2e180305).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * State of a background instance of the app (headless mode), kept on disk so that another process —
 * the CLI, a second launch of the desktop app — can see that it runs and ask it to stop.
 *
 * A signal would not be enough: on Windows `process.kill` cannot deliver anything a Node process can
 * catch, so an outside process has no way to request a graceful shutdown. The file is the channel:
 * the instance polls it and disposes the core before exiting.
 */
export interface SupervisorState {
  pid: number;
  /** `headless`: the desktop app without a window; `serve`: the CLI daemon (`jarod serve`, no Electron). */
  mode: "headless" | "serve";
  startedAt: number;
  version: string;
  profile: string;
  dataDir: string;
  /** Set by whoever asks for the shutdown; the instance notices it and exits cleanly. */
  stopRequestedAt: number | null;
}

export const SUPERVISOR_FILE = "supervisor.json";

export function supervisorPath(dataRoot: string): string {
  return join(dataRoot, SUPERVISOR_FILE);
}

export function writeSupervisorState(dataRoot: string, state: SupervisorState): void {
  mkdirSync(dirname(supervisorPath(dataRoot)), { recursive: true });
  writeFileSync(supervisorPath(dataRoot), JSON.stringify(state, null, 2));
}

/** Null when there is no state file, or when it is unreadable: never throws on a corrupt file. */
export function readSupervisorState(dataRoot: string): SupervisorState | null {
  try {
    const state = JSON.parse(readFileSync(supervisorPath(dataRoot), "utf8")) as SupervisorState;
    return typeof state?.pid === "number" && state.pid > 0 ? state : null;
  } catch {
    return null;
  }
}

/** Removes the file only if it still describes `pid`, so a dying instance cannot delete its successor's. */
export function clearSupervisorState(dataRoot: string, pid?: number): void {
  if (pid !== undefined) {
    const state = readSupervisorState(dataRoot);
    if (state && state.pid !== pid) return;
  }
  rmSync(supervisorPath(dataRoot), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to a user we cannot signal.
    return (e as { code?: string }).code === "EPERM";
  }
}

export interface SupervisorStatus {
  state: SupervisorState | null;
  running: boolean;
  /** A file left behind by a process that died without cleaning up after itself. */
  stale: boolean;
  /** Running and already asked to stop. */
  stopping: boolean;
}

export function readSupervisorStatus(dataRoot: string): SupervisorStatus {
  const state = readSupervisorState(dataRoot);
  if (!state) return { state: null, running: false, stale: false, stopping: false };
  const alive = isProcessAlive(state.pid);
  const stopping = alive && state.stopRequestedAt !== null;
  return { state, running: alive && !stopping, stale: !alive, stopping };
}

/** Asks the running instance to stop cleanly. Returns false when there is nothing to stop. */
export function requestStop(dataRoot: string, now = Date.now()): boolean {
  const status = readSupervisorStatus(dataRoot);
  if (!status.state) return false;
  if (status.stale) {
    clearSupervisorState(dataRoot, status.state.pid);
    return false;
  }
  writeSupervisorState(dataRoot, { ...status.state, stopRequestedAt: status.state.stopRequestedAt ?? now });
  return true;
}

/** What the instance itself asks on every tick: has anyone requested a stop for me? */
export function stopRequested(dataRoot: string, pid: number): boolean {
  const state = readSupervisorState(dataRoot);
  return Boolean(state && state.pid === pid && state.stopRequestedAt !== null);
}
