import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_ATTEMPTS, check, paths, score, start, status, verdict } from "./lot-lib.mjs";

function world(checks) {
  const root = mkdtempSync(join(tmpdir(), "jarod-lot-"));

  spawnSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "autonomy"));
  writeFileSync(paths(root).checks, JSON.stringify({ checks }));

  return root;
}

// A fake runner: the outcome of each check is read from a map the test mutates.
const runnerOf = (outcomes) => (c) => ({ id: c.id, ok: outcomes[c.id] !== false, ms: 0, tail: `tail-${c.id}` });
const lines = (root) => readFileSync(paths(root).journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("verdict: accept only when nothing fails; a check that passed before and fails now is a regression", () => {
  assert.deepEqual(verdict([{ id: "a", ok: true }], [{ id: "a", ok: true }]), { accept: true, regressions: [], failing: [] });
  assert.deepEqual(verdict([{ id: "a", ok: true }], [{ id: "a", ok: false }]), { accept: false, regressions: ["a"], failing: ["a"] });
  assert.equal(verdict([{ id: "a", ok: false }], [{ id: "a", ok: false }]).regressions.length, 0);
  assert.equal(score([{ ok: true }, { ok: false }]), 0.5);
});

test("a lot that keeps everything green is accepted and journalled; nothing is committed", () => {
  const root = world([{ id: "tsc" }, { id: "unit" }]);

  try {
    const outcomes = {};

    assert.equal(start(root, "L1", runnerOf(outcomes)).ok, true);
    assert.equal(check(root, "L1", runnerOf(outcomes)).verdict, "accept");
    assert.deepEqual(lines(root).map((l) => l.event), ["start", "accept"]);
    assert.equal(spawnSync("git", ["log"], { cwd: root, encoding: "utf8" }).status !== 0, true, "no commit was made");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing lot is rejected with the undo advice, and abandoned after MAX_ATTEMPTS failures, with a written trace", () => {
  const root = world([{ id: "tsc" }, { id: "unit" }]);

  try {
    const outcomes = {};

    start(root, "L2", runnerOf(outcomes));
    outcomes.unit = false;

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = check(root, "L2", runnerOf(outcomes));

      assert.equal(r.verdict, "reject");
      assert.match(r.message, /git restore|git revert/);
    }

    assert.equal(check(root, "L2", runnerOf(outcomes)).verdict, "abandon");
    assert.equal(start(root, "L2", runnerOf({})).ok, false, "an abandoned lot is not restarted silently");

    const last = lines(root).at(-1);

    assert.equal(last.event, "abandon");
    assert.deepEqual(last.failing, ["unit"]);
    assert.equal(last.tails[0].tail, "tail-unit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lot cannot pass by editing its own evaluator", () => {
  const root = world([{ id: "tsc" }, { id: "unit" }]);

  try {
    const outcomes = { unit: false };

    start(root, "L3", runnerOf(outcomes));
    writeFileSync(paths(root).checks, JSON.stringify({ checks: [{ id: "tsc" }] }));

    const r = check(root, "L3", runnerOf({}));

    assert.equal(r.verdict, "refused");
    assert.match(r.message, /own evaluator/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status merges the machine-readable backlog with the lot state", () => {
  const root = world([{ id: "tsc" }]);

  try {
    writeFileSync(paths(root).backlog, JSON.stringify({ items: [{ id: "L4", title: "x", priority: "P1" }, { id: "L5", title: "y", priority: "P2", status: "blocked-owner" }] }));
    start(root, "L4", runnerOf({}));

    assert.deepEqual(status(root).map((s) => [s.id, s.lot]), [["L4", "open"], ["L5", "blocked-owner"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
