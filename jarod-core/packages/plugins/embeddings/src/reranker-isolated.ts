/**
 * Hôte du worker du reranker ISOLÉ (SPECS-P5-RERANKER.md §2.2) : OpenVINO tourne dans un processus dédié (`reranker-worker.mjs`),
 * pas dans le processus principal d'Electron — précédent Q9 (0xC0000005 dans `inferAsync` sur NPU). Même schéma que
 * `isolated.ts` (embeddings), avec les différences voulues par le reranker :
 *
 * - le modèle met ≈ 90 s à compiler sur NPU : l'état reste « starting » jusqu'au « ready » du worker (qui n'arrive qu'une fois le modèle
 *   compilé et la sonde passée) ; `readyTimeoutMs` est donc long (défaut 300 s) ;
 * - `rerank()` n'ATTEND JAMAIS : worker pas prêt ⇒ `RERANKER_UNAVAILABLE` tout de suite, l'appelant garde l'ordre d'origine ;
 * - une requête interrompue par un plantage n'est PAS rejouée (la relance coûterait plus que le budget de latence) ;
 * - tant qu'un calcul abandonné après son échéance n'est pas fini côté worker, un nouvel appel est refusé (`RERANKER_BUSY`) ;
 * - port occupé / aucun appareil / configuration invalide : erreur franche, AUCUNE relance (elle ne changerait rien) ;
 * - le journal ne contient que des pids, des ports, des codes — jamais la requête ni un document.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsWorkerProcess, EmbeddingsWorkerSpawner } from "./isolated.js";
import { RerankerError, type RerankerMetrics } from "./reranker.js";

export type RerankerWorkerProcess = EmbeddingsWorkerProcess;
export type RerankerWorkerSpawner = EmbeddingsWorkerSpawner;

/** `reranker-worker.mjs`, livré à côté de ce fichier (exécuté tel quel, TypeScript par tsx). */
export const RERANKER_WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "reranker-worker.mjs");

export type RerankerWorkerState = "idle" | "starting" | "ready" | "failed" | "stopped";

export interface RerankerWorkerEvent {
  pid: number | null;
  /** Code de sortie tel que rapporté (0xC0000005 = 3221225477) ; null : tué (délai dépassé) ou inconnu. */
  code: number | null;
  reason: "exit" | "timeout" | "port-busy";
  outcome: "restarted" | "gave-up";
  restartsInWindow: number;
}

export interface IsolatedRerankerOptions {
  spawn: RerankerWorkerSpawner;
  /** Défaut : `RERANKER_WORKER_PATH`. */
  script?: string;
  /** Envoyé tel quel au worker (`RerankerConfig` : `modelDir`, `port` FIXE, `batch`, `maxLength`, `devices`). */
  config: Record<string, unknown> & { modelDir: string; port: number };
  log?: (line: string) => void;
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Délai pour que le worker annonce « ready » : le modèle se COMPILE avant (≈ 90 s sur NPU) ; défaut 300 s. */
  readyTimeoutMs?: number;
  /** Plafond dur d'une requête, échéance de l'appelant comprise (défaut 120 s). */
  requestTimeoutMs?: number;
  /**
   * Un calcul qui n'a pas fini ce délai après l'ÉCHÉANCE de l'appelant est considéré bloqué (le natif ne répond plus) : le worker est tué et
   * relancé (compté comme une relance). Sans cela l'hôte resterait « occupé » (RERANKER_BUSY) jusqu'à l'arrêt de l'application. Défaut 30 s.
   */
  stuckMs?: number;
  /**
   * SPECS-P5-RERANKER-PAUSE.md §3 : attendu AVANT chaque lancement du processus (premier démarrage et relances) ; typiquement `voice.whenIdle()`,
   * pour ne jamais compiler le modèle (≈ 90 s sur NPU) pendant une dictée. Une compilation déjà en cours n'est pas interrompue. S'il rejette,
   * le lancement a lieu quand même (la voix ne bloque jamais le reranker).
   */
  beforeLaunch?: () => Promise<void>;
  onExit?: (event: RerankerWorkerEvent) => void;
}

/** Codes qui ne servent à rien de relancer : le résultat serait le même. */
const FATAL = new Set(["RERANKER_PORT_BUSY", "RERANKER_BAD_CONFIG", "RERANKER_LISTEN_FAILED", "RERANKER_NO_DEVICE", "RERANKER_INIT_FAILED"]);

interface Waiter {
  resolve(): void;
  reject(e: Error): void;
}

export interface RerankResult {
  index: number;
  score: number;
}

export class IsolatedReranker {
  private proc: RerankerWorkerProcess | null = null;
  private _state: RerankerWorkerState = "idle";
  private _lastError: { code: string; message: string } | null = null;
  private waiters: Waiter[] = [];
  private restarts: number[] = [];
  private stopping = false;
  private lastMetrics: RerankerMetrics | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = 0;
  /** Appareil annoncé par le « ready » du worker (connu avant la première requête). */
  private readyDevice: string | null = null;

  constructor(private readonly opts: IsolatedRerankerOptions) {}

  get state(): RerankerWorkerState {
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
  /** URL de base, déduite du port FIXE (connue avant même que le worker soit prêt). */
  get url(): string {
    return `http://127.0.0.1:${this.opts.config.port}/v1`;
  }

  private log(line: string): void {
    this.opts.log?.(`reranker (worker isolé) : ${line}`);
  }

  /** Lance le worker ; ne bloque pas (`ready()` attend la fin de la compilation). Sans effet s'il tourne déjà. */
  start(): void {
    if (this._state !== "idle" && this._state !== "stopped") return;
    this.stopping = false;
    this.restarts = [];
    this._lastError = null;
    this.launch();
  }

  private launchSeq = 0;

  /** Lance le processus, après `beforeLaunch` s'il existe ; l'état est « starting » pendant l'attente (`rerank` refuse sans attendre). */
  private launch(): void {
    const gate = this.opts.beforeLaunch;
    if (!gate) {
      this.spawnWorker();
      return;
    }
    this._state = "starting";
    const seq = ++this.launchSeq;
    let waited: Promise<void>;
    try {
      waited = Promise.resolve(gate());
    } catch (e) {
      waited = Promise.reject(e);
    }
    void waited
      .catch((e) => this.log(`attente de la voix en erreur, lancement poursuivi : ${(e as Error).message}`))
      .then(() => {
        if (seq !== this.launchSeq || this.stopping) return; // arrêté (ou relancé) pendant l'attente
        this.spawnWorker();
      });
  }

  private spawnWorker(): void {
    const proc = this.opts.spawn(this.opts.script ?? RERANKER_WORKER_PATH);
    this.proc = proc;
    this._state = "starting";
    let reported: { code: string; message: string } | null = null;
    let timedOut = false;
    // `utilityProcess` n'a pas de pid au `fork` et l'oublie à sa mort : relu à chaque message, gardé pour l'événement de sortie.
    let launchedPid = proc.pid ?? null;
    this.log(`lancé (pid ${launchedPid ?? "?"}, port ${this.opts.config.port})`);
    const readyMs = this.opts.readyTimeoutMs ?? 300_000;
    this.readyTimer = setTimeout(() => {
      if (this.proc !== proc || this._state !== "starting") return;
      timedOut = true;
      this.log(`pas de « ready » après ${readyMs} ms : processus arrêté (pid ${proc.pid ?? "?"})`);
      proc.kill();
    }, readyMs);

    proc.onMessage((raw) => {
      if (this.proc !== proc) return;
      launchedPid = proc.pid ?? launchedPid;
      const m = raw as { type?: string; code?: string; message?: string; metrics?: RerankerMetrics; device?: string } | null;
      if (m?.type === "ready") {
        this.clearReadyTimer();
        this._state = "ready";
        this.readyDevice = typeof m.device === "string" ? m.device : null;
        this.log(`prêt (pid ${proc.pid ?? "?"}, appareil ${m.device ?? "?"})`);
        for (const w of this.waiters.splice(0)) w.resolve();
      } else if (m?.type === "listening") {
        this.log(`port ${this.opts.config.port} pris, compilation du modèle en cours`);
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

  private onExited(proc: RerankerWorkerProcess, code: number | null, reported: { code: string; message: string } | null, timedOut: boolean, pid: number | null): void {
    if (this.proc !== proc) return;
    this.clearReadyTimer();
    this.proc = null;
    if (this.stopping) {
      this._state = "stopped";
      return;
    }
    if (reported && FATAL.has(reported.code)) {
      this.giveUp(reported.code, reported.message, { pid, code, reason: "port-busy", outcome: "gave-up", restartsInWindow: this.restarts.length });
      return;
    }
    const now = Date.now();
    const windowMs = this.opts.restartWindowMs ?? 60_000;
    this.restarts = this.restarts.filter((t) => now - t < windowMs);
    const max = this.opts.maxRestarts ?? 5;
    const reason = timedOut ? "timeout" : "exit";
    if (this.restarts.length >= max) {
      this.giveUp("RERANKER_WORKER_GAVE_UP", `${this.restarts.length} relances en ${windowMs} ms, abandon (dernier code de sortie : ${code ?? "tué"}).`, {
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

  private giveUp(errorCode: string, message: string, event: RerankerWorkerEvent): void {
    this._state = "failed";
    this._lastError = { code: errorCode, message };
    this.log(`${errorCode} : ${message}`);
    this.notify(event);
    const err = new RerankerError(errorCode, message);
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  /** L'observateur de l'hôte ne doit jamais casser la relance. */
  private notify(event: RerankerWorkerEvent): void {
    try {
      this.opts.onExit?.(event);
    } catch (e) {
      this.log(`observateur des arrêts en erreur : ${(e as Error).message}`);
    }
  }

  /** Résout quand le worker est prêt (modèle compilé) ; rejette (avec le code) s'il est en échec définitif, arrêté ou jamais lancé. */
  ready(): Promise<void> {
    if (this._state === "ready") return Promise.resolve();
    if (this._state === "failed" && this._lastError) return Promise.reject(new RerankerError(this._lastError.code, this._lastError.message));
    if (this._state === "starting") return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    return Promise.reject(new RerankerError("RERANKER_UNAVAILABLE", `worker ${this._state === "stopped" ? "arrêté" : "non lancé"}.`));
  }

  /**
   * Classe `documents` selon `query` ; `[{ index, score }]` triés par score décroissant (indices d'entrée). Rend à l'échéance
   * `deadlineMs` (RERANKER_TIMEOUT) même si le worker calcule encore : ce calcul garde l'hôte « occupé » jusqu'à sa fin.
   */
  async rerank(query: string, documents: readonly string[], deadlineMs: number): Promise<RerankResult[]> {
    if (this._state !== "ready") throw new RerankerError("RERANKER_UNAVAILABLE", `worker ${this._state === "starting" ? "en cours de compilation" : this._state === "failed" ? "en échec" : "non prêt"}.`);
    if (this.inFlight > 0) throw new RerankerError("RERANKER_BUSY", "un calcul est encore en cours dans le worker.");
    this.inFlight++;
    const work = this.post(query, documents).finally(() => {
      this.inFlight--;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RerankerError("RERANKER_TIMEOUT", `échéance de ${deadlineMs} ms dépassée.`)), deadlineMs);
    });
    // Le calcul abandonné ne doit pas produire de rejet non géré.
    work.catch(() => {});
    try {
      return await Promise.race([work, deadline]);
    } catch (e) {
      if (e instanceof RerankerError && e.code === "RERANKER_TIMEOUT") this.watchStuck(work);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Après une échéance : si le calcul ne finit pas dans `stuckMs`, le worker est bloqué — on le tue, l'hôte le relance. */
  private watchStuck(work: Promise<unknown>): void {
    const proc = this.proc;
    let settled = false;
    void work.then(
      () => void (settled = true),
      () => void (settled = true),
    );
    setTimeout(() => {
      if (settled || this.proc !== proc || !proc || this._state !== "ready") return;
      this.log(`calcul bloqué depuis plus de ${this.opts.stuckMs ?? 30_000} ms après l'échéance : processus arrêté (pid ${proc.pid ?? "?"}), relance`);
      proc.kill();
    }, this.opts.stuckMs ?? 30_000).unref?.();
  }

  private async post(query: string, documents: readonly string[]): Promise<RerankResult[]> {
    let res: Response;
    try {
      res = await fetch(`${this.url}/rerank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, documents }),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 120_000),
      });
    } catch (e) {
      // Le message natif de fetch peut citer l'URL ; jamais le corps. On ne garde que le code.
      throw new RerankerError("RERANKER_UNAVAILABLE", `requête interrompue (${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name}).`);
    }
    if (!res.ok) {
      let code = `HTTP_${res.status}`;
      try {
        code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code;
      } catch {
        /* corps non JSON : on garde le code HTTP */
      }
      throw new RerankerError(code.startsWith("RERANKER_") ? code : "RERANKER_REQUEST_FAILED", code);
    }
    const body = (await res.json()) as { results?: { index: number; relevance_score: number }[] };
    if (!Array.isArray(body.results) || body.results.length !== documents.length) {
      throw new RerankerError("RERANKER_BAD_RESULT", `${body.results?.length ?? 0} résultat(s) pour ${documents.length} document(s).`);
    }
    return body.results.map((r) => ({ index: r.index, score: r.relevance_score }));
  }

  metrics(): RerankerMetrics {
    const base: RerankerMetrics = this.lastMetrics ?? { available: false, requested: [], device: null, attempts: [], calls: 0, candidates: 0, p50Ms: null, p95Ms: null, lastError: null };
    return { ...base, device: base.device ?? this.readyDevice, available: this.available, lastError: this._lastError ? `${this._lastError.code} : ${this._lastError.message}` : base.lastError };
  }

  /** Arrête le worker (idempotent) : plus aucune relance. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.launchSeq++; // annule un lancement en attente de la voix
    this.clearReadyTimer();
    const proc = this.proc;
    const err = new RerankerError("RERANKER_UNAVAILABLE", "worker arrêté.");
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
