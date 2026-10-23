/**
 * Hôte d'un worker d'embeddings ISOLÉ (SPECS-P5-EMBEDDINGS.md §3.2–3.3, §10) : OpenVINO tourne dans un processus dédié
 * (`embeddings-worker.mjs`), pas dans le processus principal d'Electron — précédent Q9 (0xC0000005 dans `inferAsync` sur NPU,
 * DECISIONS 2026-09-27 « Incident »). Même schéma que le mot d'activation (`plugins/voice/src/wakeword-isolated.ts`) :
 *
 * - `start()` ne bloque pas : le lancement de l'application n'attend ni le processus ni la compilation du modèle ;
 * - un processus mort est relancé aussitôt, au plus `maxRestarts` fois par `restartWindowMs` ; au-delà : `EMBEDDINGS_WORKER_GAVE_UP` ;
 * - port occupé : `EMBEDDINGS_PORT_BUSY`, AUCUNE relance (elle ne changerait rien) et aucun repli sur un autre port ;
 * - une requête interrompue par un plantage est rejouée (un embedding est une fonction pure de son texte) ;
 * - le journal ne contient que des pids, des codes de sortie et des codes d'erreur — jamais un texte de document.
 */
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import type { EmbeddingsEngine } from "./index.js";
import { childEnv } from "@jarod/kernel/child-env";

/** Le processus dédié, vu de l'hôte : `utilityProcess` (Electron) et `ChildProcess` s'y ramènent. */
export interface EmbeddingsWorkerProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(cb: (message: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export type EmbeddingsWorkerSpawner = (script: string) => EmbeddingsWorkerProcess;

/** `embeddings-worker.mjs`, livré à côté de ce fichier (exécuté tel quel, TypeScript par tsx). */
export const EMBEDDINGS_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "embeddings-worker.mjs");

/** Hors Electron (CLI, tests) : `child_process.fork`, sérialisation « advanced ». `env` s'ajoute à l'environnement hérité. */
export function forkEmbeddingsSpawner(o: { env?: Record<string, string> } = {}): EmbeddingsWorkerSpawner {
  return (script) => {
    const child = fork(script, [], {
      execArgv: [],
      serialization: "advanced",
      // Sous Electron sans utilityProcess, l'exécutable est electron.exe : il doit se comporter en Node.
      env: childEnv("engine", { explicit: { ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), ...o.env } }),
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

export type EmbeddingsWorkerState = "idle" | "starting" | "ready" | "failed" | "stopped";

/** Erreur à code stable (`EMBEDDINGS_PORT_BUSY`, `EMBEDDINGS_WORKER_GAVE_UP`, `EMBEDDINGS_UNAVAILABLE`, …). */
export class EmbeddingsWorkerError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code} : ${detail}`);
    this.name = "EmbeddingsWorkerError";
  }
}

export interface EmbeddingsWorkerEvent {
  pid: number | null;
  /** Code de sortie tel que rapporté (0xC0000005 = 3221225477) ; null : tué (délai dépassé) ou inconnu. */
  code: number | null;
  reason: "exit" | "timeout" | "port-busy";
  /** `restarted` : un nouveau processus est lancé ; `gave-up` : plus de processus. */
  outcome: "restarted" | "gave-up";
  /** Relances dans la fenêtre glissante, celle-ci comprise (abandon : relances déjà faites). */
  restartsInWindow: number;
}

export interface IsolatedEmbeddingsOptions {
  spawn: EmbeddingsWorkerSpawner;
  /** Défaut : `EMBEDDINGS_WORKER_PATH`. */
  script?: string;
  /** Envoyé tel quel au worker (`modelDir`, `port` FIXE, `devices`, longueurs, mise en commun). */
  config: Record<string, unknown> & { modelDir: string; port: number };
  log?: (line: string) => void;
  /** Relances admises par fenêtre glissante (défaut 5 par minute, comme le mot d'activation). */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Délai pour que le worker annonce « ready » (le modèle se compile à la première requête, pas ici ; défaut 60 s). */
  readyTimeoutMs?: number;
  /** Délai d'une requête d'embeddings (défaut 180 s : démarrage à froid du modèle compris). */
  requestTimeoutMs?: number;
  /** Essais d'une même requête à travers des relances (défaut 2). */
  attempts?: number;
  /** Chaque arrêt non demandé, après décision : relancé ou abandonné. */
  onExit?: (event: EmbeddingsWorkerEvent) => void;
}

interface Waiter {
  resolve(): void;
  reject(e: Error): void;
}

export class IsolatedEmbeddings implements EmbeddingsEngine {
  private proc: EmbeddingsWorkerProcess | null = null;
  private _state: EmbeddingsWorkerState = "idle";
  private _lastError: { code: string; message: string } | null = null;
  private waiters: Waiter[] = [];
  private restarts: number[] = [];
  private stopping = false;
  private lastMetrics: EmbeddingsMetrics | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: IsolatedEmbeddingsOptions) {}

  get state(): EmbeddingsWorkerState {
    return this._state;
  }
  get available(): boolean {
    return this._state === "ready";
  }
  get lastError(): { code: string; message: string } | null {
    return this._lastError;
  }
  get pid(): number | undefined {
    return this.proc?.pid;
  }
  /** URL de base OpenAI-compatible, déduite du port FIXE (connue avant même que le worker soit prêt). */
  get url(): string {
    return `http://127.0.0.1:${this.opts.config.port}/v1`;
  }

  private log(line: string): void {
    this.opts.log?.(`embeddings (worker isolé) : ${line}`);
  }

  /** Lance le worker ; ne bloque pas (`ready()` attend le port). Sans effet s'il tourne déjà. */
  start(): void {
    if (this._state !== "idle" && this._state !== "stopped") return;
    this.stopping = false;
    this.restarts = [];
    this._lastError = null;
    this.launch();
  }

  private launch(): void {
    const proc = this.opts.spawn(this.opts.script ?? EMBEDDINGS_WORKER_PATH);
    this.proc = proc;
    this._state = "starting";
    let reported: { code: string; message: string } | null = null;
    let timedOut = false;
    // `utilityProcess` (Electron) n'a pas de pid au `fork` (il apparaît au démarrage du processus) et l'oublie dès sa mort : le pid est
    // relu à chaque message du worker et celui connu est gardé pour l'événement de sortie.
    let launchedPid = proc.pid ?? null;
    this.log(`lancé (pid ${launchedPid ?? "?"}, port ${this.opts.config.port})`);
    this.readyTimer = setTimeout(() => {
      if (this.proc !== proc || this._state !== "starting") return;
      timedOut = true;
      this.log(`pas de « ready » après ${this.opts.readyTimeoutMs ?? 60_000} ms : processus arrêté (pid ${proc.pid ?? "?"})`);
      proc.kill();
    }, this.opts.readyTimeoutMs ?? 60_000);

    proc.onMessage((raw) => {
      if (this.proc !== proc) return;
      launchedPid = proc.pid ?? launchedPid;
      const m = raw as { type?: string; code?: string; message?: string; metrics?: EmbeddingsMetrics } | null;
      if (m?.type === "ready") {
        this.clearReadyTimer();
        this._state = "ready";
        this.log(`prêt (pid ${proc.pid ?? "?"})`);
        for (const w of this.waiters.splice(0)) w.resolve();
      } else if (m?.type === "error" && m.code) {
        reported = { code: m.code, message: String(m.message ?? "") };
      } else if (m?.type === "metrics" && m.metrics) {
        this.lastMetrics = m.metrics;
      }
    });
    proc.onExit((code) => this.onExited(proc, code, reported, timedOut, launchedPid));
    proc.postMessage({ type: "start", config: this.opts.config });
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private onExited(proc: EmbeddingsWorkerProcess, code: number | null, reported: { code: string; message: string } | null, timedOut: boolean, pid: number | null): void {
    if (this.proc !== proc) return;
    this.clearReadyTimer();
    this.proc = null;
    if (this.stopping) {
      this._state = "stopped";
      return;
    }
    if (reported?.code === "EMBEDDINGS_PORT_BUSY" || reported?.code === "EMBEDDINGS_BAD_CONFIG" || reported?.code === "EMBEDDINGS_LISTEN_FAILED") {
      this.giveUp(reported.code, reported.message, { pid, code, reason: "port-busy", outcome: "gave-up", restartsInWindow: this.restarts.length });
      return;
    }
    const now = Date.now();
    const windowMs = this.opts.restartWindowMs ?? 60_000;
    this.restarts = this.restarts.filter((t) => now - t < windowMs);
    const max = this.opts.maxRestarts ?? 5;
    const reason = timedOut ? "timeout" : "exit";
    if (this.restarts.length >= max) {
      this.giveUp("EMBEDDINGS_WORKER_GAVE_UP", `${this.restarts.length} relances en ${windowMs} ms, abandon (dernier code de sortie : ${code ?? "tué"}).`, {
        pid,
        code,
        reason,
        outcome: "gave-up",
        restartsInWindow: this.restarts.length,
      });
      return;
    }
    this.restarts.push(now);
    this.log(`processus mort (pid ${pid ?? "?"}, code ${code ?? "tué"}) : relance ${this.restarts.length}/${max}`);
    this.notify({ pid, code, reason, outcome: "restarted", restartsInWindow: this.restarts.length });
    this.launch();
  }

  private giveUp(errorCode: string, message: string, event: EmbeddingsWorkerEvent): void {
    this._state = "failed";
    this._lastError = { code: errorCode, message };
    this.log(`${errorCode} : ${message}`);
    this.notify(event);
    const err = new EmbeddingsWorkerError(errorCode, message);
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  /** L'observateur de l'hôte ne doit jamais casser la relance. */
  private notify(event: EmbeddingsWorkerEvent): void {
    try {
      this.opts.onExit?.(event);
    } catch (e) {
      this.log(`observateur des arrêts en erreur : ${(e as Error).message}`);
    }
  }

  /** Résout quand le worker est prêt ; rejette (avec le code) s'il est en échec définitif, arrêté ou jamais lancé. */
  ready(): Promise<void> {
    if (this._state === "ready") return Promise.resolve();
    if (this._state === "failed" && this._lastError) return Promise.reject(new EmbeddingsWorkerError(this._lastError.code, this._lastError.message));
    if (this._state === "starting") return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    return Promise.reject(new EmbeddingsWorkerError("EMBEDDINGS_UNAVAILABLE", `worker ${this._state === "stopped" ? "arrêté" : "non lancé"}.`));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const attempts = this.opts.attempts ?? 2;
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      await this.ready();
      try {
        return await this.post(texts);
      } catch (e) {
        if (e instanceof EmbeddingsWorkerError) throw e; // réponse d'erreur du worker : rejouer ne changerait rien
        last = e;
        // Laisser l'hôte voir la mort du processus avant de rejouer (l'état passe de « ready » à « starting » / « failed »).
        const end = Date.now() + 1_000;
        while (this._state === "ready" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      }
    }
    throw new EmbeddingsWorkerError("EMBEDDINGS_UNAVAILABLE", `requête interrompue ${attempts} fois (${(last as Error | undefined)?.message ?? "inconnu"}).`);
  }

  private async post(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.url}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: texts }),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 180_000),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail;
      } catch {
        /* corps non JSON : on garde le code HTTP */
      }
      throw new EmbeddingsWorkerError("EMBEDDINGS_REQUEST_FAILED", detail);
    }
    const body = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (data.length !== texts.length) throw new EmbeddingsWorkerError("EMBEDDINGS_REQUEST_FAILED", `${data.length} vecteur(s) reçu(s) pour ${texts.length} texte(s).`);
    return data.map((d) => Float32Array.from(d.embedding));
  }

  /** Le nombre de tokens se calcule dans le worker (tokenizer natif) : non exposé à l'hôte. */
  tokens(): Promise<number> {
    return Promise.reject(new EmbeddingsWorkerError("EMBEDDINGS_UNAVAILABLE", "le nombre de tokens n'est pas exposé en mode isolé."));
  }

  /** La compilation se fait à la première requête dans le worker : rien à faire ici (`warmup` n'est pas supporté en mode isolé). */
  async warmup(): Promise<void> {}

  metrics(): EmbeddingsMetrics {
    const base: EmbeddingsMetrics = this.lastMetrics ?? { available: false, requested: [], device: {}, attempts: [], calls: 0, texts: 0, p50Ms: null, p95Ms: null, lastError: null };
    return { ...base, available: this.available, lastError: this._lastError ? `${this._lastError.code} : ${this._lastError.message}` : base.lastError };
  }

  /** Arrête le worker (idempotent) : plus aucune relance. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearReadyTimer();
    const proc = this.proc;
    const err = new EmbeddingsWorkerError("EMBEDDINGS_UNAVAILABLE", "worker arrêté.");
    for (const w of this.waiters.splice(0)) w.reject(err);
    if (!proc) {
      if (this._state !== "idle") this._state = "stopped";
      return;
    }
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2_000);
      proc.onExit(() => {
        clearTimeout(t);
        resolve();
      });
    });
    try {
      proc.postMessage({ type: "shutdown" });
    } catch {
      /* canal déjà fermé */
    }
    proc.kill();
    await exited;
    this.proc = null;
    this._state = "stopped";
    this.log(`arrêté (pid ${proc.pid ?? "?"})`);
  }
}
