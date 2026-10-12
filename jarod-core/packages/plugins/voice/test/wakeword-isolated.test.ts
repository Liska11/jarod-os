/**
 * Q9 (option A) — mot d'activation dans un processus dédié (`wakeword-isolated.ts`) : relance après un
 * plantage, recompilation des modèles dans le nouveau processus, appel rejoué, abandon au-delà du quota,
 * processus tué au-delà du délai. Processus simulés en mémoire, puis un vrai `fork` arrêté brutalement.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { forkWorkerSpawner, IsolatedWakeWordRuntime, type WorkerProcess, type WorkerSpawner } from "../src/wakeword-isolated.js";

afterEach(cleanup);

const ACCESS_VIOLATION = 0xc0000005;

/**
 * Processus simulé : répond comme `wakeword-worker.cjs` (sortie = entrée × 2). `crashOn(n)` : le n-ième
 * message (tous processus confondus) tue le processus au lieu de répondre ; `hangOn(n)` : pas de réponse.
 */
function fakeSpawner(
  opts: { crashOn?: (n: number, m: { t: string }) => boolean; hangOn?: (n: number) => boolean; failOn?: (n: number) => boolean; neverReady?: boolean } = {},
) {
  const log: { pid: number; t: string; id?: number }[] = [];
  const procs: { pid: number; alive: boolean }[] = [];
  let n = 0;
  const spawn: WorkerSpawner = () => {
    const pid = 1000 + procs.length;
    const me = { pid, alive: true };
    procs.push(me);
    let onMsg: (m: unknown) => void = () => {};
    let onExit: (code: number | null) => void = () => {};
    const compiled = new Set<number>();
    const exit = (code: number | null) => {
      if (!me.alive) return;
      me.alive = false;
      queueMicrotask(() => onExit(code));
    };
    const proc: WorkerProcess = {
      pid,
      postMessage(raw) {
        const m = raw as { t: string; seq: number; id: number; input?: Float32Array };
        const k = ++n;
        log.push({ pid, t: m.t, id: m.id });
        if (opts.crashOn?.(k, m)) return exit(ACCESS_VIOLATION);
        if (opts.hangOn?.(k)) return;
        queueMicrotask(() => {
          if (!me.alive) return;
          if (opts.failOn?.(k)) {
            onMsg({ t: "result", seq: m.seq, ok: false, error: "Compilation failed on NPU" });
          } else if (m.t === "compile") {
            compiled.add(m.id);
            onMsg({ t: "result", seq: m.seq, ok: true, value: null });
          } else if (!compiled.has(m.id)) {
            onMsg({ t: "result", seq: m.seq, ok: false, error: `WAKEWORD_WORKER_UNKNOWN_MODEL: ${m.id}` });
          } else {
            onMsg({ t: "result", seq: m.seq, ok: true, value: m.input!.map((v) => v * 2) });
          }
        });
      },
      onMessage: (cb) => void (onMsg = cb),
      onExit: (cb) => void (onExit = cb),
      kill: () => exit(null),
    };
    if (!opts.neverReady) queueMicrotask(() => me.alive && onMsg({ t: "ready", pid }));
    return proc;
  };
  return { spawn, log, procs };
}

describe("IsolatedWakeWordRuntime", () => {
  it("compile et infère dans le processus dédié", async () => {
    const f = fakeSpawner();
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn });
    const m = await rt.compile("mel.onnx", [1, 4], "NPU");
    expect(Array.from(await m(Float32Array.of(1, 2)))).toEqual([2, 4]);
    expect(rt.stats()).toMatchObject({ pid: 1000, starts: 1, crashes: [], gaveUp: null });
    rt.dispose();
  });

  it("plantage pendant une inférence : processus relancé, modèle recompilé, appel rejoué, même résultat", async () => {
    // Messages : 1 compile, 2 infer (ok), 3 infer → plantage ; puis 4 compile et 5 infer sur le nouveau.
    const f = fakeSpawner({ crashOn: (k) => k === 3 });
    const lines: string[] = [];
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn, log: (l) => lines.push(l) });
    const m = await rt.compile("emb.onnx", [1, 2], "NPU");
    await m(Float32Array.of(1, 1));
    expect(Array.from(await m(Float32Array.of(3, 5)))).toEqual([6, 10]);
    expect(f.log.map((e) => `${e.pid}:${e.t}`)).toEqual(["1000:compile", "1000:infer", "1000:infer", "1001:compile", "1001:infer"]);
    const s = rt.stats();
    expect(s).toMatchObject({ pid: 1001, starts: 2, gaveUp: null });
    expect(s.crashes).toEqual([expect.objectContaining({ pid: 1000, code: ACCESS_VIOLATION, reason: "exit" })]);
    expect(lines.some((l) => l.includes("0xC0000005"))).toBe(true);
    rt.dispose();
  });

  it("plantage pendant une compilation : rejouée sur le processus relancé (pas de repli de périphérique)", async () => {
    const f = fakeSpawner({ crashOn: (k) => k === 1 });
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn });
    const m = await rt.compile("mel.onnx", [1, 1], "NPU");
    expect(Array.from(await m(Float32Array.of(7)))).toEqual([14]);
    expect(rt.stats().crashes).toHaveLength(1);
    rt.dispose();
  });

  it("les modèles compilés sont tous recompilés dans le nouveau processus, chacun à son prochain appel", async () => {
    const f = fakeSpawner({ crashOn: (k) => k === 4 });
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn });
    const a = await rt.compile("a.onnx", [1, 1], "NPU");
    const b = await rt.compile("b.onnx", [1, 1], "CPU");
    await a(Float32Array.of(1)); // 3
    await a(Float32Array.of(1)); // 4 → plantage, rejoué : 5 compile a, 6 infer a
    await b(Float32Array.of(1)); // 7 compile b, 8 infer b
    expect(f.log.slice(4).map((e) => `${e.pid}:${e.t}:${e.id}`)).toEqual(["1001:compile:1", "1001:infer:1", "1001:compile:2", "1001:infer:2"]);
    rt.dispose();
  });

  it("une erreur OpenVINO ordinaire remonte sans relance (le détecteur passe au périphérique suivant)", async () => {
    const f = fakeSpawner({ failOn: (k) => k === 1 });
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn });
    await expect(rt.compile("a.onnx", [1, 1], "NPU")).rejects.toThrow("Compilation failed on NPU");
    const m = await rt.compile("a.onnx", [1, 1], "CPU");
    expect(Array.from(await m(Float32Array.of(2)))).toEqual([4]);
    expect(rt.stats()).toMatchObject({ starts: 1, crashes: [] });
    rt.dispose();
  });

  it("plante à chaque appel : abandon au-delà du quota de relances, sans boucle", async () => {
    const f = fakeSpawner({ crashOn: (_k, m) => m.t === "infer" });
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn, maxRestarts: 2, attempts: 2 });
    const m = await rt.compile("a.onnx", [1, 1], "NPU");
    await expect(m(Float32Array.of(1))).rejects.toThrow(/WAKEWORD_WORKER_CRASHED/); // 2 essais, 2 plantages
    await expect(m(Float32Array.of(1))).rejects.toThrow(/WAKEWORD_WORKER_CRASHED/); // 3e plantage : quota atteint
    expect(rt.stats().gaveUp).toMatch(/WAKEWORD_WORKER_GAVE_UP/);
    await expect(m(Float32Array.of(1))).rejects.toThrow(/WAKEWORD_WORKER_GAVE_UP/); // plus de relance
    expect(rt.stats()).toMatchObject({ starts: 3, pid: null });
    expect(rt.stats().crashes).toHaveLength(3);
    rt.dispose();
  });

  it("onExit : chaque arrêt signalé à l'hôte, relancé puis abandonné, horodaté ; un observateur en erreur ne casse pas la relance", async () => {
    const f = fakeSpawner({ crashOn: (_k, m) => m.t === "infer" });
    const events: import("../src/wakeword-isolated.js").WorkerExitEvent[] = [];
    const rt = new IsolatedWakeWordRuntime({
      spawn: f.spawn,
      maxRestarts: 2,
      attempts: 2,
      onExit: (e) => {
        events.push(e);
        throw new Error("observateur cassé");
      },
    });
    const m = await rt.compile("a.onnx", [1, 1], "NPU");
    const t0 = Date.now();
    await expect(m(Float32Array.of(1))).rejects.toThrow(/WAKEWORD_WORKER_CRASHED/);
    await expect(m(Float32Array.of(1))).rejects.toThrow(/WAKEWORD_WORKER_CRASHED/);
    expect(events.map((e) => [e.outcome, e.restartsInWindow, e.crash.pid, e.crash.code])).toEqual([
      ["restarted", 1, 1000, ACCESS_VIOLATION],
      ["restarted", 2, 1001, ACCESS_VIOLATION],
      ["gave-up", 2, 1002, ACCESS_VIOLATION],
    ]);
    expect(events[2]!.gaveUp).toMatch(/WAKEWORD_WORKER_GAVE_UP/);
    for (const e of events) expect(e.crash.at).toBeGreaterThanOrEqual(t0);
    rt.dispose();
  });

  it("sans réponse au-delà du délai : processus tué, relancé, appel rejoué", async () => {
    const f = fakeSpawner({ hangOn: (k) => k === 2 });
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn, inferTimeoutMs: 20 });
    const m = await rt.compile("a.onnx", [1, 1], "NPU");
    expect(Array.from(await m(Float32Array.of(4)))).toEqual([8]);
    expect(rt.stats().crashes).toEqual([expect.objectContaining({ pid: 1000, code: null, reason: "timeout" })]);
    rt.dispose();
  });

  it("processus jamais prêt : tué au délai de démarrage, l'appel échoue au lieu d'attendre", async () => {
    const f = fakeSpawner({ neverReady: true });
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn, readyTimeoutMs: 10, maxRestarts: 0 });
    await expect(rt.compile("a.onnx", [1, 1], "NPU")).rejects.toThrow(/WAKEWORD_WORKER/);
    rt.dispose();
  });

  it("dispose : processus tué, plus aucun appel, arrêt non compté comme plantage", async () => {
    const f = fakeSpawner();
    const rt = new IsolatedWakeWordRuntime({ spawn: f.spawn });
    const m = await rt.compile("a.onnx", [1, 1], "NPU");
    rt.dispose();
    await Promise.resolve();
    expect(f.procs[0]!.alive).toBe(false);
    expect(rt.stats().crashes).toEqual([]);
    await expect(m(Float32Array.of(1))).rejects.toThrow(/WAKEWORD_WORKER_STOPPED/);
  });

  it("vrai processus (fork) : un arrêt brutal pendant l'appel est contenu, relancé et rejoué", async () => {
    // Même protocole que wakeword-worker.cjs, sans OpenVINO ; entrée [-1] au 1er processus = arrêt brutal.
    const dir = tempDir();
    const script = join(dir, "worker.cjs");
    writeFileSync(
      script,
      `"use strict";
const gen = Number(process.env.GEN_FILE ? require("node:fs").readFileSync(process.env.GEN_FILE, "utf8") || 0 : 0);
require("node:fs").writeFileSync(process.env.GEN_FILE, String(gen + 1));
process.on("message", (m) => {
  if (m.t === "infer" && m.input[0] === -1 && gen === 0) process.kill(process.pid, "SIGKILL");
  process.send({ t: "result", seq: m.seq, ok: true, value: m.t === "infer" ? Float32Array.from(m.input, (v) => v + 1) : null });
});
process.send({ t: "ready", pid: process.pid });
`,
    );
    const genFile = join(dir, "gen.txt");
    writeFileSync(genFile, "0");
    process.env.GEN_FILE = genFile;
    const rt = new IsolatedWakeWordRuntime({ spawn: forkWorkerSpawner(), script });
    try {
      const m = await rt.compile("a.onnx", [1, 2], "NPU");
      const first = rt.stats().pid;
      const out = await m(Float32Array.of(-1, 1));
      expect(out).toBeInstanceOf(Float32Array);
      expect(Array.from(out)).toEqual([0, 2]);
      const s = rt.stats();
      expect(s.starts).toBe(2);
      expect(s.crashes).toHaveLength(1);
      expect(s.crashes[0]!.pid).toBe(first);
      expect(s.crashes[0]!.code).not.toBe(0);
      expect(s.pid).not.toBe(first);
      expect(s.pid).not.toBe(process.pid);
    } finally {
      rt.dispose();
      delete process.env.GEN_FILE;
    }
  });
});
