/**
 * Moteur du reranker (SPECS-P5-RERANKER.md §2.3–2.4) : bge-reranker-v2-m3 INT8 sur NPU, lu par `TextRerankPipeline` de
 * `openvino-genai-node`. Deux faits mesurés le 2026-10-01 le contraignent :
 *
 * - le NPU ne compile le modèle qu'à FORMES STATIQUES (IR figée par `make-static-reranker`, lot × longueur), et le pipeline pousse
 *   tous les candidats d'un appel dans un seul tenseur : le lot est FIXE — moins de candidats = remplissage vide, plus = plusieurs
 *   appels ;
 * - les scores rendus sont des probabilités saturées (≈ 1 ou ≈ 0) : seul l'ORDRE est fiable.
 *
 * Comme les embeddings (PLAN §7.3) : les appareils s'essaient dans l'ordre, un appareil ne sert que s'il compile ET passe une sonde,
 * l'appareil effectif est rapporté, jamais de repli silencieux. La sonde est une séparation a priori (documents pertinents au-dessus de
 * tous les non pertinents) : elle ne demande pas de seconde compilation CPU ; la parité NPU/CPU sur les vraies questions est mesurée
 * par la gate (SPECS-P5-RERANKER.md §8 c). Aucun texte de requête ni de document dans les journaux ni les métriques.
 */
import type { RerankerConfig } from "@jarod/contracts";
import type * as Genai from "openvino-genai-node";

/** Chargé au premier usage : les DLL OpenVINO n'ont rien à faire dans un processus sans RAG. */
let genai: Promise<typeof Genai> | null = null;
const loadGenai = () => (genai ??= import("openvino-genai-node"));

/** Erreur à code stable (`RERANKER_NO_DEVICE`, `RERANKER_UNAVAILABLE`, `RERANKER_BAD_RESULT`, `RERANKER_TIMEOUT`, …). */
export class RerankerError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code} : ${detail}`);
    this.name = "RerankerError";
  }
}

/** Ce que le moteur demande à OpenVINO : classer `documents` (autant que le lot) selon `query`, `[indice, score]` triés par score. */
export interface RerankPipeline {
  rerank(query: string, documents: string[]): Promise<[number, number][]>;
}
export interface RerankRuntime {
  compile(modelDir: string, device: string, opts: { batch: number; maxLength: number }): Promise<RerankPipeline>;
}

/** Runtime réel. NB : la fabrique prend `(chemin, { device, config })` — un second argument texte serait IGNORÉ sans erreur. */
export function genaiRerankRuntime(): RerankRuntime {
  return {
    async compile(modelDir, device, o) {
      const { TextRerankPipeline } = await loadGenai();
      const pipeline = await TextRerankPipeline(modelDir, { device, config: { top_n: o.batch, max_length: o.maxLength, pad_to_max_length: true } });
      return { rerank: async (query, documents) => (await pipeline.rerank(query, documents)) as [number, number][] };
    },
  };
}

// ── Sonde ───────────────────────────────────────────────────────────────────────────────────────

/** Requête et documents sondes : neutres, sans lien avec un corpus ; les étiquettes sont a priori (pas de référence CPU à calculer). */
export const PROBE_QUERY = "Quelle est la capitale de la France ?";
const PROBE_RELEVANT = ["Paris est la capitale de la France.", "La capitale de la France est Paris, sur la Seine."];
const PROBE_IRRELEVANT = [
  "La pâte à crêpes demande de la farine, des œufs et du lait.",
  "Un moteur à quatre temps comprend admission, compression, combustion et échappement.",
  "Le mode WAL de SQLite autorise des lectures pendant une écriture.",
  "Les baleines bleues se nourrissent surtout de krill.",
  "Beethoven a composé la sonate au clair de lune en 1801.",
  "Le sel se dissout dans l'eau chaude plus vite que dans l'eau froide.",
];

/** `batch` documents sondes (les textes se répètent au-delà de huit) et les indices des pertinents. */
export function probeDocs(batch: number): { docs: string[]; relevant: Set<number> } {
  const docs: string[] = [];
  const relevant = new Set<number>();
  for (let i = 0; i < batch; i++) {
    // Un pertinent tous les quatre documents, intercalé avec des non pertinents.
    if (i % 4 === 0) {
      relevant.add(i);
      docs.push(PROBE_RELEVANT[(i / 4) % PROBE_RELEVANT.length]!);
    } else docs.push(PROBE_IRRELEVANT[i % PROBE_IRRELEVANT.length]!);
  }
  return { docs, relevant };
}

/** Tout pertinent strictement au-dessus de tout non pertinent (l'égalité ne sépare pas). */
export function classCorrect(scores: readonly number[], relevant: ReadonlySet<number>): boolean {
  const rel = scores.filter((_, i) => relevant.has(i));
  const irr = scores.filter((_, i) => !relevant.has(i));
  if (!rel.length || !irr.length) return false;
  return Math.min(...rel) > Math.max(...irr);
}

// ── Lots ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Remplissage d'un lot incomplet. JAMAIS vide ni court : le tokenizer de `TextRerankPipeline` (openvino-genai 2026.4) échoue
 * (« CombineSegments … out_offset <= flat_out_size ») quand les documents d'un lot sont trop courts — mesuré le 2026-10-01 : 3 documents
 * réels courts + 5 remplissages vides échouent, avec ce texte long ils passent. Un lot de 8 documents RÉELS tous minuscules échoue aussi :
 * défaut du tokenizer, non corrigeable ici, rendu comme une erreur (l'appelant garde l'ordre d'origine).
 */
export const PAD_TEXT =
  "Ce texte de remplissage neutre ne parle ni de réseaux, ni d'opérateurs, ni de procédures : il sert seulement à occuper une place dans un lot de taille fixe afin que le calcul reste valide et sans effet sur les autres documents classés.";

export interface BatchScorer {
  readonly batch: number;
  /** EXACTEMENT `batch` documents ; un score par document, dans l'ordre d'entrée. */
  scoreBatch(query: string, documents: string[]): Promise<number[]>;
}

/**
 * Scores de tous les candidats, dans l'ordre d'entrée : lots séquentiels de `batch`, le dernier rempli de textes vides (calcul perdu,
 * ordre inchangé) ; le remplissage n'apparaît pas dans le résultat.
 */
export async function scoreAll(scorer: BatchScorer, query: string, documents: readonly string[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < documents.length; i += scorer.batch) {
    const slice = documents.slice(i, i + scorer.batch);
    const padded = slice.length === scorer.batch ? [...slice] : [...slice, ...Array<string>(scorer.batch - slice.length).fill(PAD_TEXT)];
    const scores = await scorer.scoreBatch(query, padded);
    if (scores.length !== scorer.batch) throw new RerankerError("RERANKER_BAD_RESULT", `${scores.length} score(s) pour un lot de ${scorer.batch}.`);
    out.push(...scores.slice(0, slice.length));
  }
  return out;
}

// ── Moteur OpenVINO ─────────────────────────────────────────────────────────────────────────────

export type ResolvedRerankerConfig = Required<Pick<RerankerConfig, "modelDir" | "port">> & { batch: number; maxLength: number; devices: string[] };

export interface RerankerMetrics {
  available: boolean;
  requested: string[];
  /** Appareil effectif ; null tant qu'aucun n'a servi. */
  device: string | null;
  attempts: { device: string; ok: boolean; ms: number; error?: string }[];
  calls: number;
  /** Candidats vus (remplissage compris). */
  candidates: number;
  p50Ms: number | null;
  p95Ms: number | null;
  lastError: string | null;
}

const WINDOW = 1000;
const pct = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

export class OpenVinoReranker implements BatchScorer {
  private pipeline: RerankPipeline | null = null;
  private effective: string | null = null;
  private readonly attempts: RerankerMetrics["attempts"] = [];
  private readonly latencies: number[] = [];
  private calls = 0;
  private candidates = 0;
  private lastError: string | null = null;
  /** Les appels sont sérialisés : un pipeline OpenVINO ne sert qu'une requête à la fois. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: ResolvedRerankerConfig,
    private readonly runtime: RerankRuntime = genaiRerankRuntime(),
    private readonly log: (line: string) => void = () => {},
  ) {}

  get batch(): number {
    return this.cfg.batch;
  }
  get available(): boolean {
    return this.pipeline !== null;
  }

  /** Essaie les appareils dans l'ordre ; rejette `RERANKER_NO_DEVICE` si aucun ne compile et ne sépare la sonde. */
  async init(): Promise<void> {
    const { docs, relevant } = probeDocs(this.cfg.batch);
    for (const device of this.cfg.devices) {
      const t0 = Date.now();
      try {
        const pipeline = await this.runtime.compile(this.cfg.modelDir, device, { batch: this.cfg.batch, maxLength: this.cfg.maxLength });
        const scores = fromPairs(await pipeline.rerank(PROBE_QUERY, docs), docs.length);
        if (!classCorrect(scores, relevant)) throw new RerankerError("RERANKER_PROBE_FAILED", "la sonde ne sépare pas les documents pertinents des autres");
        this.pipeline = pipeline;
        this.effective = device;
        this.attempts.push({ device, ok: true, ms: Date.now() - t0 });
        this.log(`reranker : ${device} compilé et sonde passée en ${Date.now() - t0} ms`);
        return;
      } catch (e) {
        const error = (e as Error).message.replace(/\s+/g, " ").slice(0, 200);
        this.attempts.push({ device, ok: false, ms: Date.now() - t0, error });
        this.log(`reranker : ${device} refusé (${error}), essai suivant`);
      }
    }
    this.lastError = `RERANKER_NO_DEVICE : aucun périphérique n'a compilé le modèle (${this.cfg.devices.join(", ")}).`;
    throw new RerankerError("RERANKER_NO_DEVICE", `aucun périphérique n'a compilé le modèle (${this.cfg.devices.join(", ")}).`);
  }

  scoreBatch(query: string, documents: string[]): Promise<number[]> {
    const run = async (): Promise<number[]> => {
      if (!this.pipeline) throw new RerankerError("RERANKER_UNAVAILABLE", "modèle non compilé.");
      if (documents.length !== this.cfg.batch) throw new RerankerError("RERANKER_BAD_BATCH", `lot de ${documents.length} documents pour une IR figée à ${this.cfg.batch}.`);
      const t0 = Date.now();
      try {
        return fromPairs(await this.pipeline.rerank(query, documents), documents.length);
      } catch (e) {
        this.lastError = `${(e as { code?: string }).code ?? "RERANKER_FAILED"}`;
        throw e;
      } finally {
        this.calls++;
        this.candidates += documents.length;
        this.latencies.push(Date.now() - t0);
        if (this.latencies.length > WINDOW) this.latencies.shift();
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }

  metrics(): RerankerMetrics {
    return {
      available: this.available,
      requested: this.cfg.devices,
      device: this.effective,
      attempts: [...this.attempts],
      calls: this.calls,
      candidates: this.candidates,
      p50Ms: pct(this.latencies, 50),
      p95Ms: pct(this.latencies, 95),
      lastError: this.lastError,
    };
  }
}

/** `[[indice, score], …]` triés → un score par indice d'entrée. */
function fromPairs(pairs: readonly [number, number][], n: number): number[] {
  const scores = Array<number>(n).fill(Number.NEGATIVE_INFINITY);
  const seen = new Set<number>();
  for (const [i, s] of pairs) {
    if (!Number.isInteger(i) || i < 0 || i >= n || typeof s !== "number") throw new RerankerError("RERANKER_BAD_RESULT", "indice ou score invalide.");
    scores[i] = s;
    seen.add(i);
  }
  if (seen.size !== n) throw new RerankerError("RERANKER_BAD_RESULT", `${seen.size} résultat(s) pour ${n} document(s).`);
  return scores;
}
