// Local "lot" gate: propose -> evaluate -> accept/reject -> journal, for one small batch of changes at a time.
//
// Deliberately small and removable: no dependency, nothing imports it, nothing runs it by itself.
// It NEVER commits, pushes, resets or deletes: on a rejection it only says what to run to undo the lot.
// The evaluator (autonomy/checks.json) is fingerprinted when a lot starts; a lot whose evaluator changed
// since is refused, so a lot cannot make itself pass by editing the checks (autoresearch / harness pattern).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAX_ATTEMPTS = 3;

const sha = (text) => createHash("sha256").update(text).digest("hex");
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function paths(root) {
  const dir = join(root, "autonomy");

  return { dir, checks: join(dir, "checks.json"), backlog: join(dir, "backlog.json"), journal: join(dir, "journal.jsonl"), state: join(dir, "lots.json") };
}

/** Default runner: a command line through the shell of the OS, bounded by a timeout; never given a secret. */
export function shellRunner(check, root) {
  const started = Date.now();
  const result = spawnSync(check.cmd, { cwd: join(root, check.cwd ?? "."), shell: true, encoding: "utf8", timeout: (check.timeoutSec ?? 600) * 1000, windowsHide: true });

  return { id: check.id, ok: result.status === 0 && !result.error, ms: Date.now() - started, tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-400) };
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });

  return r.status === 0 ? r.stdout.trim() : "";
}

function journal(p, record) {
  mkdirSync(p.dir, { recursive: true });
  appendFileSync(p.journal, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

function evaluate(root, p, runner) {
  const text = readFileSync(p.checks, "utf8");
  const checks = JSON.parse(text).checks ?? [];

  return { evaluator: sha(text), results: checks.map((c) => runner(c, root)) };
}

/** Score = passing checks / checks. Informational: the verdict never depends on it alone. */
export function score(results) {
  return results.length === 0 ? 0 : results.filter((r) => r.ok).length / results.length;
}

/** A lot is accepted only if nothing that passed at the baseline fails now, and every check passes now when it passed before. */
export function verdict(baseline, now) {
  const before = new Map(baseline.map((r) => [r.id, r.ok]));
  const regressions = now.filter((r) => !r.ok && before.get(r.id) === true).map((r) => r.id);
  const failing = now.filter((r) => !r.ok).map((r) => r.id);

  return { accept: failing.length === 0, regressions, failing };
}

export function start(root, id, runner = shellRunner) {
  const p = paths(root);
  const state = readJson(p.state, {});
  const lot = state[id] ?? { attempts: 0 };

  if (lot.status === "abandoned") {
    return { ok: false, message: `lot ${id} was abandoned after ${lot.attempts} failed attempts; read ${p.journal} and decide by hand` };
  }

  const base = evaluate(root, p, runner);

  state[id] = { ...lot, status: "open", head: git(root, ["rev-parse", "HEAD"]), evaluator: base.evaluator, baseline: base.results };
  writeJson(p.state, state);
  journal(p, { event: "start", lot: id, head: state[id].head, evaluator: base.evaluator, score: score(base.results), failingAtBaseline: base.results.filter((r) => !r.ok).map((r) => r.id) });

  return { ok: true, message: `lot ${id} started at ${state[id].head.slice(0, 8)}, baseline score ${score(base.results).toFixed(2)}` };
}

export function check(root, id, runner = shellRunner) {
  const p = paths(root);
  const state = readJson(p.state, {});
  const lot = state[id];

  if (!lot || lot.status !== "open") {
    return { ok: false, verdict: "refused", message: `lot ${id} is not open (run start first)` };
  }

  const now = evaluate(root, p, runner);

  if (now.evaluator !== lot.evaluator) {
    journal(p, { event: "refused", lot: id, reason: "evaluator changed since the lot started" });

    return { ok: false, verdict: "refused", message: "autonomy/checks.json changed since the lot started: a lot may not edit its own evaluator" };
  }

  const v = verdict(lot.baseline, now.results);
  const s = score(now.results);

  if (v.accept) {
    state[id] = { ...lot, status: "accepted" };
    writeJson(p.state, state);
    journal(p, { event: "accept", lot: id, score: s, files: git(root, ["diff", "--stat", lot.head]).split("\n").slice(-1)[0] ?? "" });

    return { ok: true, verdict: "accept", message: `ACCEPT ${id}: score ${s.toFixed(2)}. Commit it yourself; this tool never does.` };
  }

  const attempts = lot.attempts + 1;
  const abandoned = attempts >= MAX_ATTEMPTS;

  state[id] = { ...lot, attempts, status: abandoned ? "abandoned" : "open" };
  writeJson(p.state, state);
  journal(p, { event: abandoned ? "abandon" : "reject", lot: id, attempt: attempts, score: s, failing: v.failing, regressions: v.regressions, tails: now.results.filter((r) => !r.ok).map((r) => ({ id: r.id, tail: r.tail })) });

  const undo = `to undo this lot's edits: git restore --source=${lot.head.slice(0, 8)} --staged --worktree -- <files>   (or git revert if committed)`;

  return { ok: false, verdict: abandoned ? "abandon" : "reject", message: `${abandoned ? "ABANDONED" : "REJECT"} ${id} (attempt ${attempts}/${MAX_ATTEMPTS}): failing ${v.failing.join(", ")}${v.regressions.length ? `; regressions ${v.regressions.join(", ")}` : ""}. ${undo}` };
}

export function status(root) {
  const p = paths(root);
  const backlog = readJson(p.backlog, { items: [] }).items;
  const state = readJson(p.state, {});

  return backlog.map((item) => ({ id: item.id, title: item.title, priority: item.priority, lot: state[item.id]?.status ?? item.status ?? "todo", attempts: state[item.id]?.attempts ?? 0 }));
}
