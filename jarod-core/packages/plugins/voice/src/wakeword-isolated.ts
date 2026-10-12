/**
 * Mot d'activation hors du processus hôte (Q9, option A ; même schéma que les plugins isolés U2) :
 * `WakeWordRuntime` dont les compilations et inférences OpenVINO tournent dans un processus dédié
 * (`wakeword-worker.cjs`). Un plantage natif de ce processus (0xC0000005 dans `inferAsync` sur NPU,
 * DECISIONS 2026-09-27 « Incident ») n'emporte plus l'application :
 *
 * - le processus mort est relancé aussitôt, au plus `maxRestarts` fois par `restartWindowMs` ; au-delà
 *   le runtime abandonne (WAKEWORD_WORKER_GAVE_UP) plutôt que de boucler ;
 * - les modèles déjà compilés le sont de nouveau, dans le nouveau processus, à leur prochain appel
 *   (même chemin, même forme, même périphérique : le choix NPU → GPU → CPU du détecteur ne se refait pas) ;
 * - l'appel interrompu est rejoué (`attempts`, défaut 2) : une inférence est une fonction pure de son
 *   entrée (l'état du flux est dans le détecteur), le rejouer ne change rien au résultat ;
 * - un appel sans réponse au-delà de son délai tue le processus (même traitement qu'un plantage).
 *
 * Chaque plantage est journalisé (pid, code de sortie) et compté (`stats()`), et signalé à l'hôte par
 * `onExit` (issue : relancé ou abandonné) — le desktop y branche le fil de déclenchement Q9 (journal
 * horodaté, minidump attendu). Les erreurs OpenVINO ordinaires (compilation refusée par un
 * périphérique…) remontent telles quelles, sans relance.
 */
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledModel, WakeWordRuntime } from "./wakeword.js";

/** Le processus dédié, vu de l'hôte : `utilityProcess` (Electron) et `ChildProcess` s'y ramènent. */
export interface WorkerProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(cb: (message: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export type WorkerSpawner = (script: string) => WorkerProcess;

/** `wakeword-worker.cjs`, livré à côté de ce fichier (exécuté tel quel, sans compilation). */
export const WAKEWORD_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "wakeword-worker.cjs");

/** Hors Electron (CLI, tests) : `child_process.fork`, sérialisation « advanced » (les `Float32Array` passent). */
export function forkWorkerSpawner(): WorkerSpawner {
  return (script) => {
    const child = fork(script, [], {
      execArgv: [],
      serialization: "advanced",
      // Sous Electron sans utilityProcess, l'exécutable est electron.exe : il doit se comporter en Node.
      env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      windowsHide: true,
    });
    return {
      get pid() {
        return child.pid;
      },
      postMessage: (m) => void child.send(m as never),
      onMessage: (cb) => void child.on("message", cb),
      onExit: (cb) => void child.on("exit", (code) => cb(code)),
      kill: () => void child.kill(),
    };
  };
}

export interface IsolatedRuntimeOptions {
  spawn: WorkerSpawner;
  /** Défaut : `WAKEWORD_WORKER_PATH`. */
  script?: string;
  /** Journal : `info` (démarrage), `warn` (plantage, délai, rejeu, abandon). */
  log?: (line: string, level: "info" | "warn") => void;
  /** Relances admises par fenêtre glissante (défaut 5 par minute). */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Essais d'un même appel à travers des relances (défaut 2). */
  attempts?: number;
  /** Délais : démarrage du processus, compilation, inférence (défauts 30 s, 120 s, 10 s). */
  readyTimeoutMs?: number;
  compileTimeoutMs?: number;
  inferTimeoutMs?: number;
  /** Chaque arrêt non demandé (plantage, délai), après décision : relancé ou abandonné. */
  onExit?: (event: WorkerExitEvent) => void;
}

export interface WorkerExitEvent {
  crash: WorkerCrash;
  /** `restarted` : un nouveau processus est lancé ; `gave-up` : quota de relances atteint, plus de processus. */
  outcome: "restarted" | "gave-up";
  /** Relances dans la fenêtre glissante, celle-ci comprise (abandon : relances déjà faites). */
  restartsInWindow: number;
  gaveUp: string | null;
}

export interface WorkerCrash {
  pid: number | null;
  /** Code de sortie tel que rapporté (0xC0000005 = 3221225477) ; null : tué (délai dépassé). */
  code: number | null;
  at: number;
  reason: "exit" | "timeout";
}

export interface WorkerStats {
  pid: number | null;
  starts: number;
  crashes: WorkerCrash[];
  gaveUp: string | null;
}

/** Le processus a disparu pendant l'appel : l'appel peut être rejoué sur le suivant. */
export class WorkerCrashError extends Error {
  constructor(readonly crash: WorkerCrash) {
    super(`WAKEWORD_WORKER_CRASHED: processus du mot d'activation ${crash.pid ?? "?"} arrêté (${describeExit(crash)})`);
  }
}

export function describeExit(c: Pick<WorkerCrash, "code" | "reason">): string {
  if (c.reason === "timeout") return "délai dépassé, tué";
  return c.code === null ? "sans code" : `code ${c.code} = 0x${(c.code >>> 0).toString(16).toUpperCase()}`;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Worker {
  gen: number;
  proc: WorkerProcess;
  pid: number | null;
  ready: Promise<void>;
  /** Rejette `ready` si le processus meurt avant d'être prêt. */
  fail(e: Error): void;
  pending: Map<number, Pending>;
  timedOut: boolean;
}

export class IsolatedWakeWordRuntime implements WakeWordRuntime {
  private readonly script: string;
  private readonly log: (line: string, level?: "info" | "warn") => void;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly attempts: number;
  private readonly readyTimeoutMs: number;
  private readonly compileTimeoutMs: number;
  private readonly inferTimeoutMs: number;
  private worker: Worker | null = null;
  private gen = 0;
  private seq = 0;
  private nextId = 0;
  private readonly handles = new Map<number, { path: string; shape: number[]; device: string; gen: number }>();
  private readonly restarts: number[] = [];
  private readonly crashes: WorkerCrash[] = [];
  private gaveUp: string | null = null;
  private disposed = false;

  constructor(private readonly opts: IsolatedRuntimeOptions) {
    this.script = opts.script ?? WAKEWORD_WORKER_PATH;
    this.log = (line, level = "warn") => opts.log?.(line, level);
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.restartWindowMs = opts.restartWindowMs ?? 60_000;
    this.attempts = opts.attempts ?? 2;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
    this.compileTimeoutMs = opts.compileTimeoutMs ?? 120_000;
    this.inferTimeoutMs = opts.inferTimeoutMs ?? 10_000;
  }

  stats(): WorkerStats {
    return { pid: this.worker?.pid ?? null, starts: this.gen, crashes: [...this.crashes], gaveUp: this.gaveUp };
  }

  /** Démarre le processus maintenant (sinon : au premier appel). */
  start(): Promise<void> {
    return this.current().ready;
  }

  async compile(path: string, shape: number[], device: string): Promise<CompiledModel> {
    const id = ++this.nextId;
    this.handles.set(id, { path, shape, device, gen: 0 });
    try {
      await this.retrying(() => this.ensureCompiled(id));
    } catch (e) {
      this.handles.delete(id);
      throw e;
    }
    return (input) =>
      this.retrying(async () => {
        const w = await this.ensureCompiled(id);
        return (await this.call(w, { t: "infer", id, input }, this.inferTimeoutMs)) as Float32Array;
      });
  }

  /** Arrête le processus ; les appels en cours échouent. Définitif. */
  dispose(): void {
    this.disposed = true;
    const w = this.worker;
    this.worker = null;
    if (!w) return;
    for (const p of w.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("WAKEWORD_WORKER_STOPPED: runtime arrêté"));
    }
    w.pending.clear();
    w.proc.kill();
  }

  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof WorkerCrashError) || attempt >= this.attempts || this.gaveUp || this.disposed) throw e;
        this.log(`mot d'activation : appel rejoué sur le processus relancé (essai ${attempt + 1}/${this.attempts})`);
      }
    }
  }

  private async ensureCompiled(id: number): Promise<Worker> {
    const h = this.handles.get(id)!;
    const w = this.current();
    await w.ready;
    if (h.gen !== w.gen) {
      await this.call(w, { t: "compile", id, path: h.path, shape: h.shape, device: h.device }, this.compileTimeoutMs);
      h.gen = w.gen;
    }
    return w;
  }

  private current(): Worker {
    if (this.disposed) throw new Error("WAKEWORD_WORKER_STOPPED: runtime arrêté");
    if (this.gaveUp) throw new Error(this.gaveUp);
    return (this.worker ??= this.spawn());
  }

  private spawn(): Worker {
    const gen = ++this.gen;
    const proc = this.opts.spawn(this.script);
    let ready!: { resolve(): void; reject(e: Error): void };
    const w: Worker = {
      gen,
      proc,
      pid: proc.pid ?? null,
      ready: new Promise<void>((resolve, reject) => (ready = { resolve, reject })),
      fail: (e) => ready.reject(e),
      pending: new Map(),
      timedOut: false,
    };
    w.ready.catch(() => {}); // rejet observé par les appels en attente
    const readyTimer = setTimeout(() => {
      w.timedOut = true;
      proc.kill();
    }, this.readyTimeoutMs);
    proc.onMessage((raw) => {
      const m = raw as { t?: string; pid?: number; seq?: number; ok?: boolean; value?: unknown; error?: string };
      if (m?.t === "ready") {
        clearTimeout(readyTimer);
        if (typeof m.pid === "number") w.pid = m.pid;
        this.log(`mot d'activation : processus dédié ${w.pid ?? "?"} prêt (démarrage n° ${gen})`, "info");
        ready.resolve();
      } else if (m?.t === "result" && typeof m.seq === "number") {
        const p = w.pending.get(m.seq);
        if (!p) return;
        w.pending.delete(m.seq);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error ?? "erreur inconnue du processus du mot d'activation"));
      }
    });
    proc.onExit((code) => {
      clearTimeout(readyTimer);
      this.onExit(w, code);
    });
    return w;
  }

  private onExit(w: Worker, code: number | null): void {
    if (this.worker === w) this.worker = null;
    if (this.disposed) return;
    const crash: WorkerCrash = { pid: w.pid, code, at: Date.now(), reason: w.timedOut ? "timeout" : "exit" };
    this.crashes.push(crash);
    if (this.crashes.length > 100) this.crashes.splice(0, this.crashes.length - 100);
    const error = new WorkerCrashError(crash);
    this.log(`mot d'activation : ${error.message}`);
    w.fail(error);
    for (const p of w.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    w.pending.clear();
    const now = Date.now();
    while (this.restarts.length && now - this.restarts[0]! > this.restartWindowMs) this.restarts.shift();
    if (this.restarts.length >= this.maxRestarts) {
      this.gaveUp = `WAKEWORD_WORKER_GAVE_UP: ${this.restarts.length + 1} arrêts en ${Math.round(this.restartWindowMs / 1000)} s, processus du mot d'activation abandonné`;
      this.log(`mot d'activation : ${this.gaveUp}`);
      this.notify({ crash, outcome: "gave-up", restartsInWindow: this.restarts.length, gaveUp: this.gaveUp });
      return;
    }
    this.restarts.push(now);
    // Relance immédiate : l'écoute est permanente, le prochain bloc audio ne doit pas attendre le démarrage.
    this.worker = this.spawn();
    this.notify({ crash, outcome: "restarted", restartsInWindow: this.restarts.length, gaveUp: null });
  }

  /** L'observateur de l'hôte ne doit jamais casser la relance. */
  private notify(event: WorkerExitEvent): void {
    try {
      this.opts.onExit?.(event);
    } catch (e) {
      this.log(`mot d'activation : observateur des arrêts en erreur : ${(e as Error).message}`);
    }
  }

  private call(w: Worker, msg: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.worker !== w) {
      return Promise.reject(new WorkerCrashError({ pid: w.pid, code: null, at: Date.now(), reason: "exit" }));
    }
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log(`mot d'activation : ${String(msg.t)} sans réponse après ${timeoutMs} ms, processus ${w.pid ?? "?"} tué`);
        w.timedOut = true;
        w.proc.kill();
      }, timeoutMs);
      w.pending.set(seq, { resolve, reject, timer });
      w.proc.postMessage({ ...msg, seq });
    });
  }
}
