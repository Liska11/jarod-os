/**
 * `ctx.reranker` : le contrat `RerankerProvider` de @jarod/contracts (PLAN §10 phase 3) au-dessus du worker isolé
 * (SPECS-P5-RERANKER.md §2–3). Les candidats arrivent DÉJÀ fusionnés (top-N), jamais le corpus ; le lot fixe du NPU est caché ici
 * (le worker découpe et remplit). Un service inactif (pas de `reranker.json`, RAG éteint, drapeau éteint) dit pourquoi et n'échoue
 * jamais en silence : `rerank` rejette avec un code, l'appelant garde l'ordre d'origine (repli du contrat).
 */
import type { EngineInfo, RerankHit, RerankRequest, RerankerProvider, VoicePriority } from "@jarod/contracts";
import { RerankerError, type RerankerMetrics } from "./reranker.js";

/** Ce que le service attend d'un hôte : l'hôte du worker isolé, ou un faux en test. */
export interface RerankHost {
  readonly available: boolean;
  /** Pid du worker quand l'hôte en a un (tests d'arrêt brutal, journaux) ; jamais utilisé pour décider. */
  readonly pid?: number | undefined;
  rerank(query: string, documents: readonly string[], deadlineMs: number): Promise<{ index: number; score: number }[]>;
  metrics(): RerankerMetrics;
}

/** Plafond de candidats par appel : quatre lots (le worker en accepte 64). */
const MAX_LOTS = 4;

/** SPECS-P5-RERANKER-PAUSE.md : la voix est prioritaire sur le reclassement. */
export interface RerankerVoiceOptions {
  /** Priorité de la voix, lue PARESSEUSEMENT à chaque appel (le plugin `voice` peut se charger avant ou après celui-ci). */
  voice?: () => VoicePriority | undefined;
  /** `false` = condition témoin du banc : aucune pause. Défaut vrai. */
  voicePriority?: boolean;
  log?: (line: string) => void;
}

export class RerankerService implements RerankerProvider {
  readonly maxCandidates: number;
  private paused = 0;

  constructor(
    private readonly host: RerankHost | null,
    private readonly shape: { batch: number; maxLength: number },
    /** Raison de l'inactivité, pour les messages d'erreur. */
    private readonly inactiveReason: string | null = null,
    private readonly opts: RerankerVoiceOptions = {},
  ) {
    this.maxCandidates = shape.batch * MAX_LOTS;
  }

  /** Reclassements refusés parce que la voix était active (tests, banc). */
  get pausedCount(): number {
    return this.paused;
  }

  /** Vrai si la voix est active ; une défaillance de la lecture ne bloque JAMAIS le reclassement (fail-open). */
  private voiceActive(): boolean {
    if (this.opts.voicePriority === false) return false;
    try {
      return this.opts.voice?.()?.active === true;
    } catch (e) {
      this.opts.log?.(`voix prioritaire indisponible, reclassement sans pause : ${(e as Error).message}`);
      return false;
    }
  }

  get available(): boolean {
    return this.host?.available === true;
  }

  /** Pid du worker isolé s'il tourne ; sert aux tests d'arrêt brutal et aux journaux, rien d'autre. */
  get pid(): number | undefined {
    return this.host?.pid;
  }

  info(): EngineInfo {
    const device = this.host?.metrics().device;
    return { name: "bge-reranker-v2-m3", version: `int8-b${this.shape.batch}x${this.shape.maxLength}`, ...(device ? { device } : {}) };
  }

  metrics(): RerankerMetrics {
    return this.host?.metrics() ?? { available: false, requested: [], device: null, attempts: [], calls: 0, candidates: 0, p50Ms: null, p95Ms: null, lastError: this.inactiveReason };
  }

  async rerank(req: RerankRequest): Promise<RerankHit[]> {
    if (req.signal?.aborted) throw new RerankerError("RERANKER_ABORTED", "requête annulée.");
    if (!this.host) throw new RerankerError("RERANKER_UNAVAILABLE", this.inactiveReason ?? "reranker inactif.");
    if (req.candidates.length === 0) return [];
    if (this.voiceActive()) {
      this.paused += 1;
      throw new RerankerError("RERANKER_PAUSED", "dictée en cours : le reclassement cède la place à la voix.");
    }
    if (req.candidates.length > this.maxCandidates) throw new RerankerError("RERANKER_TOO_MANY", `${req.candidates.length} candidats pour un maximum de ${this.maxCandidates}.`);
    const ranked = await this.host.rerank(req.query, req.candidates.map((c) => c.text), req.deadlineMs);
    return ranked.slice(0, Math.max(0, req.topN)).map((r) => ({ id: req.candidates[r.index]!.id, score: r.score }));
  }
}
