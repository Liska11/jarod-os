// Portage de packages/core/test/supervisor.test.ts (rév. 2e180305).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSupervisorState,
  isProcessAlive,
  readSupervisorState,
  readSupervisorStatus,
  requestStop,
  type SupervisorState,
  stopRequested,
  supervisorPath,
  writeSupervisorState,
} from "../src/supervisor.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarod-supervisor-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A pid that cannot be running: well beyond any platform's range. */
const DEAD_PID = 999_999_999;

const state = (over: Partial<SupervisorState> = {}): SupervisorState => ({
  pid: process.pid,
  mode: "headless",
  startedAt: Date.now(),
  version: "0.1.0",
  profile: "default",
  dataDir: "/donnees",
  stopRequestedAt: null,
  ...over,
});

describe("supervisor state file", () => {
  it("round-trips an instance description", () => {
    const root = temp();
    writeSupervisorState(root, state({ pid: 4242, profile: "travail" }));

    const read = readSupervisorState(root);

    expect(read?.pid).toBe(4242);
    expect(read?.profile).toBe("travail");
    expect(read?.mode).toBe("headless");
  });

  it("returns null instead of throwing on a missing or corrupt file", () => {
    const root = temp();
    expect(readSupervisorState(root)).toBeNull();

    writeFileSync(supervisorPath(root), "{ pas du json");
    expect(readSupervisorState(root)).toBeNull();

    writeFileSync(supervisorPath(root), JSON.stringify({ pid: "x" }));
    expect(readSupervisorState(root)).toBeNull();
  });

  it("treats a live process as running and a dead pid as stale", () => {
    const root = temp();
    writeSupervisorState(root, state({ pid: process.pid }));
    expect(readSupervisorStatus(root)).toMatchObject({ running: true, stale: false, stopping: false });

    writeSupervisorState(root, state({ pid: DEAD_PID }));
    expect(readSupervisorStatus(root)).toMatchObject({ running: false, stale: true, stopping: false });
  });

  it("reports stopping once a stop has been requested, for that instance only", () => {
    const root = temp();
    writeSupervisorState(root, state({ pid: process.pid }));

    expect(requestStop(root)).toBe(true);
    expect(readSupervisorStatus(root)).toMatchObject({ running: false, stopping: true });
    expect(stopRequested(root, process.pid)).toBe(true);
    // A request left by another instance is not an order for this one.
    expect(stopRequested(root, 4242)).toBe(false);
  });

  it("cleans up after an instance that died without cleaning up", () => {
    const root = temp();
    writeSupervisorState(root, state({ pid: DEAD_PID }));

    expect(requestStop(root)).toBe(false);

    expect(readSupervisorState(root)).toBeNull();
  });

  it("only removes a file that still belongs to the asking process", () => {
    const root = temp();
    writeSupervisorState(root, state({ pid: 4242 }));

    clearSupervisorState(root, 1111); // someone else's file: a dying instance must not delete it
    expect(readSupervisorState(root)?.pid).toBe(4242);

    clearSupervisorState(root, 4242);
    expect(readSupervisorState(root)).toBeNull();
  });

  it("recognises a live pid and rejects nonsense", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
