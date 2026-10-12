/**
 * Contrats de l'écosystème (PLAN §10, phase 0 ; référence non normative `docs/ECOSYSTEME.md`, « Plan
 * d'intégration »). Jarod-cordis — nouveau.
 *
 * Le kernel ne dépend d'aucun moteur concret : index vectoriel (TurboVec…), embeddings creux (FastEmbed),
 * reranker (bge-reranker-v2-m3 NPU, B5), parseur de documents (Docling) et décisions typées (Laya) passent
 * par ces cinq contrats, activés PAR PROFIL (`EcosystemFlags`, réglage `ecosystem`). Défaut = pile actuelle :
 * index en mémoire, parseur texte, pas de reranker, pas de décisions.
 *
 * Règles portées par les contrats :
 * - SQLite reste la source : un index ne garde que l'identifiant numérique stable du chunk
 *   (`rag_chunks.id`, AUTOINCREMENT, jamais réutilisé) et son vecteur ; tout index se reconstruit
 *   (`rebuild`) depuis la base. Profil, collection, ACL et provenance restent dans SQLite et arrivent au
 *   moteur sous forme d'allowlist d'identifiants.
 * - Identifiants = entiers JSON sûrs (≤ 2⁵³ − 1), pas `bigint` (écart assumé au document de référence) :
 *   ils traversent tels quels un stdio/IPC JSON vers un sidecar, et un rowid SQLite n'approche pas 2⁵³.
 * - Un moteur indisponible ou hors budget DÉGRADE (repli sur la pile actuelle), il ne bloque jamais.
 * - Une décision typée ne fait rien : elle rend des données ; le garde fail-closed, les budgets et les
 *   confirmations décident ensuite.
 * - Journal de décision : codes, nombres, versions — jamais de texte (requête, document, état, option libre).
 */
import { z } from "zod";

// ── Commun ──────────────────────────────────────────────────────────────────────────────────────

/** Identifiant stable d'un chunk (`rag_chunks.id`). */
export const ChunkId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type ChunkId = z.infer<typeof ChunkId>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Identifiant machine : nom de moteur, version, périphérique, code de raison. Sans espace, 128 caractères
 * au plus — une phrase (requête, extrait de document) n'y tient pas.
 */
export const Code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,127}$/);

/** Ce qui a réellement servi : moteur, version (révision du modèle ou de l'index), périphérique effectif. */
export const EngineInfo = z.strictObject({
  name: Code,
  version: Code,
  /** `NPU`, `GPU.0`, `CPU`, `DirectML`… — effectif, pas demandé (PLAN §7.3 : jamais de repli silencieux). */
  device: Code.optional(),
});
export type EngineInfo = z.infer<typeof EngineInfo>;

// ── Embeddings ──────────────────────────────────────────────────────────────────────────────────

export const EmbeddingKind = z.enum(["dense", "sparse"]);
export type EmbeddingKind = z.infer<typeof EmbeddingKind>;

/** Requête ou passage : certains modèles préfixent ou encodent différemment les deux (e5, FastEmbed). */
export type EmbeddingRole = "query" | "passage";

/**
 * Génération d'embeddings : tout ce qui rend deux vecteurs comparables. Un changement de l'un de ces
 * champs crée une NOUVELLE génération d'index — jamais une modification silencieuse de l'ancienne
 * (aujourd'hui : `RAG_DIM_MISMATCH` ne détecte que la dimension).
 */
export const EmbeddingModelSpec = z.strictObject({
  /** Nom du modèle tel que rangé dans `rag_chunks.model` (ex. `bge-m3-int8-ov`). */
  model: Code,
  kind: EmbeddingKind,
  /** Dimension (dense) ; null pour un vecteur creux (indices dans le vocabulaire). */
  dim: z.number().int().positive().nullable(),
  /** `symmetric` : même encodage requête et passage (bge-m3) ; `query-passage` : encodages distincts. */
  strategy: z.enum(["symmetric", "query-passage"]),
  pooling: z.enum(["cls", "mean", "none"]),
  normalize: z.boolean(),
  /** `int8`, `fp16`, `fp32`… */
  quantization: Code,
  /** Empreinte du tokenizer (null tant qu'elle n'est pas calculée). */
  tokenizerSha256: Sha256.nullable(),
});
export type EmbeddingModelSpec = z.infer<typeof EmbeddingModelSpec>;

/** Clé déterministe d'une génération : sert à nommer l'index qui lui correspond. */
export function embeddingGeneration(spec: EmbeddingModelSpec): string {
  const s = EmbeddingModelSpec.parse(spec);
  return [s.model, s.kind, s.dim ?? "sparse", s.strategy, s.pooling, s.normalize ? "l2" : "raw", s.quantization, s.tokenizerSha256 ?? "tok?"].join("|");
}

/** Vecteur creux : indices croissants dans le vocabulaire, poids associés. */
export interface SparseVector {
  indices: Uint32Array;
  values: Float32Array;
}

export type EmbeddingOf<K extends EmbeddingKind> = K extends "dense" ? Float32Array : SparseVector;

/**
 * Fournisseur d'embeddings. Dense = bge-m3 INT8 sur NPU (existant, gate P2) ; creux = FastEmbed EN
 * ADDITION seulement (DECISIONS 2026-09-28), jamais en remplacement du dense.
 */
export interface EmbeddingProvider<K extends EmbeddingKind = "dense"> {
  readonly kind: K;
  readonly available: boolean;
  describe(): EmbeddingModelSpec;
  info(): EngineInfo;
  /** Un vecteur par texte, dans l'ordre. */
  embed(texts: readonly string[], role: EmbeddingRole, signal?: AbortSignal): Promise<EmbeddingOf<K>[]>;
}

// ── Index vectoriel ─────────────────────────────────────────────────────────────────────────────

/** `memory` = index en mémoire actuel (plugin-rag `vector-index.ts`, G2). */
export const VectorIndexKind = z.enum(["memory", "turbovec", "sqlite-vec", "usearch"]);
export type VectorIndexKind = z.infer<typeof VectorIndexKind>;

export const IndexSpec = z.strictObject({
  indexId: Code,
  /** Génération d'embeddings indexée (`embeddingGeneration`) : une autre génération = un autre index. */
  embedding: EmbeddingModelSpec,
  metric: z.enum(["cosine", "dot"]),
});
export type IndexSpec = z.infer<typeof IndexSpec>;

export interface VectorRow {
  id: ChunkId;
  vector: Float32Array;
}

export interface VectorSearchRequest {
  indexId: string;
  vector: Float32Array;
  k: number;
  /**
   * Allowlist d'identifiants, calculée DANS SQLite (profil, collection, ACL, période). Absente : tout
   * l'index. Présente et vide : aucun résultat (jamais « pas de filtre »).
   */
  allow?: readonly ChunkId[];
  signal?: AbortSignal;
}

export interface VectorHit {
  id: ChunkId;
  /** Plus grand = plus proche (cosinus ou produit scalaire selon `IndexSpec.metric`). */
  score: number;
}

/** État persisté après `sync` : ce qu'une reprise après arrêt brutal retrouvera. */
export const IndexCheckpoint = z.strictObject({
  indexId: Code,
  generation: z.string().min(1),
  size: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(),
});
export type IndexCheckpoint = z.infer<typeof IndexCheckpoint>;

/** Résultat de `verify` : l'appelant compare `size` au nombre de lignes de SQLite (désynchronisation). */
export const IndexHealth = z.strictObject({
  indexId: Code,
  ok: z.boolean(),
  size: z.number().int().nonnegative(),
  generation: z.string().min(1).nullable(),
  /** Code d'erreur (ex. `corrupt`, `generation-mismatch`), jamais un message libre. */
  error: Code.optional(),
});
export type IndexHealth = z.infer<typeof IndexHealth>;

/**
 * Moteur vectoriel. Ne connaît que des identifiants et des vecteurs ; supprimer ou reconstruire l'index
 * ne perd aucune donnée métier.
 */
export interface VectorIndexProvider {
  readonly kind: VectorIndexKind;
  info(): EngineInfo;
  create(spec: IndexSpec): Promise<void>;
  upsert(indexId: string, rows: readonly VectorRow[]): Promise<void>;
  remove(indexId: string, ids: readonly ChunkId[]): Promise<void>;
  search(req: VectorSearchRequest): Promise<VectorHit[]>;
  /** Persistance incrémentale (crash-safe côté moteur). Un moteur purement en mémoire rend son état. */
  sync(indexId: string): Promise<IndexCheckpoint>;
  verify(indexId: string): Promise<IndexHealth>;
  /** Reconstruction complète depuis la source canonique (lignes lues dans SQLite par l'appelant). */
  rebuild(spec: IndexSpec, rows: AsyncIterable<VectorRow> | Iterable<VectorRow>): Promise<IndexCheckpoint>;
  close(): Promise<void>;
}

// ── Reranking ───────────────────────────────────────────────────────────────────────────────────

export interface RerankCandidate {
  id: ChunkId;
  text: string;
}

export interface RerankRequest {
  query: string;
  /** Candidats DÉJÀ fusionnés (top-N) — jamais le corpus complet. */
  candidates: readonly RerankCandidate[];
  /** Nombre de résultats rendus. */
  topN: number;
  /** Budget de latence : au-delà, l'appelant garde l'ordre d'origine (repli, pas d'échec). */
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface RerankHit {
  id: ChunkId;
  score: number;
}

/** Reranker cross-encoder. Voie officielle (phase 3) : bge-reranker-v2-m3 INT8 sur NPU (B5). */
export interface RerankerProvider {
  readonly available: boolean;
  /** Candidats acceptés par appel (NPU : formes statiques, lot fixe). */
  readonly maxCandidates: number;
  info(): EngineInfo;
  rerank(req: RerankRequest): Promise<RerankHit[]>;
}

// ── Parsing de documents ────────────────────────────────────────────────────────────────────────

/** Portion du texte extrait (décalages en unités UTF-16 de `ParsedDocument.text`), page si connue. */
const Span = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  page: z.number().int().positive().nullable(),
});

/**
 * Manifeste déterministe d'un document : même fichier + même parseur = même manifeste. Source d'un
 * rechunking ou d'un réindexage sans relire l'original.
 */
export const DocumentManifest = z.strictObject({
  manifestVersion: z.literal(1),
  parser: z.strictObject({ name: Code, version: Code }),
  source: z.strictObject({
    sha256: Sha256,
    bytes: z.number().int().nonnegative(),
    mime: Code,
  }),
  /** Code de langue détecté (`fr`, `en`…), null si inconnu. */
  language: Code.nullable(),
  pages: z.number().int().nonnegative().nullable(),
  sections: z.array(Span.extend({ level: z.number().int().positive(), title: z.string() })),
  tables: z.array(Span),
  images: z.array(Span),
  /** Erreurs non fatales (page illisible, OCR absent…), en codes. */
  errors: z.array(z.strictObject({ code: Code, page: z.number().int().positive().nullable() })),
});
export type DocumentManifest = z.infer<typeof DocumentManifest>;

export interface ParsedDocument {
  manifest: DocumentManifest;
  /** Texte normalisé (Markdown pour un parseur structuré) auquel renvoient les décalages du manifeste. */
  text: string;
}

export type DocumentInput = { path: string } | { bytes: Uint8Array; name: string; mime?: string };

/**
 * Parseur. `builtin` = lecture texte actuelle (plugin-rag `listTextFiles` + `chunkText`), repli
 * permanent ; Docling = worker Python opt-in, sous la règle Python v2 (venv dédié, DECISIONS).
 */
export interface DocumentParser {
  readonly available: boolean;
  info(): EngineInfo;
  accepts(name: string, mime?: string): boolean;
  parse(input: DocumentInput, signal?: AbortSignal): Promise<ParsedDocument>;
}

// ── Décisions typées ────────────────────────────────────────────────────────────────────────────

/** Formes `choice`, `score`, `noul` du document de référence (Laya) ; registre fermé en phase 4. */
export const DecisionQuestion = z.discriminatedUnion("type", [
  z.strictObject({ id: Code, type: z.literal("choice"), options: z.array(Code).min(2), instructions: z.string() }),
  z.strictObject({ id: Code, type: z.literal("score"), levels: z.number().int().min(2), instructions: z.string() }),
  z.strictObject({ id: Code, type: z.literal("noul"), instructions: z.string() }),
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestion>;

const Probability = z.number().min(0).max(1);

/**
 * Réponse par question ; `value: null` = abstention (confiance insuffisante ou délai dépassé). Forme de
 * `noul` à confirmer au prototype (Q16) : oui/non + probabilité du oui.
 */
export const DecisionAnswer = z.discriminatedUnion("type", [
  z.strictObject({ id: Code, type: z.literal("choice"), value: Code.nullable(), probabilities: z.array(Probability) }),
  z.strictObject({ id: Code, type: z.literal("score"), value: z.number().int().nonnegative().nullable(), probabilities: z.array(Probability) }),
  z.strictObject({ id: Code, type: z.literal("noul"), value: z.boolean().nullable(), probability: Probability }),
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

export const DecisionResult = z.strictObject({
  answers: z.array(DecisionAnswer),
  engine: EngineInfo,
  ms: z.number().nonnegative(),
  timedOut: z.boolean(),
});
export type DecisionResult = z.infer<typeof DecisionResult>;

export interface DecisionRequest {
  /** Texte évalué (demande, passage…) — jamais journalisé. */
  state: string;
  questions: readonly DecisionQuestion[];
  deadlineMs: number;
  signal?: AbortSignal;
}

/**
 * Moteur de décision (Laya via `receptron/laya`, Q16). N'exécute rien : le résultat est une donnée que
 * le policy engine déterministe (garde, budgets, confirmations) interprète.
 */
export interface DecisionEngine {
  readonly available: boolean;
  info(): EngineInfo;
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

// ── Feature flags par profil (réglage `ecosystem`) ──────────────────────────────────────────────

/**
 * Tout éteint par défaut = pile actuelle. Aucun budget n'a de valeur par défaut : il se fixe sur mesure
 * à la phase qui l'introduit (règle « aucun seuil sans décision »).
 */
export const EcosystemFlags = z.strictObject({
  /** Index servi. */
  vectorIndex: VectorIndexKind.default("memory"),
  /** Index interrogé EN PLUS, sans effet sur la réponse (mode fantôme, phase 1). */
  vectorShadow: VectorIndexKind.nullable().default(null),
  documentParser: z.enum(["builtin", "docling"]).default("builtin"),
  sparseEmbeddings: z.enum(["off", "fastembed"]).default("off"),
  reranker: z.enum(["off", "bge-reranker-v2-m3-npu"]).default("off"),
  rerankTopN: z.number().int().positive().optional(),
  rerankDeadlineMs: z.number().positive().optional(),
  /** `shadow` : le reclassement est calculé et journalisé, jamais servi (SPECS-P5-RERANKER.md §3) ; `active` : servi, par décision de l'utilisateur. */
  rerankMode: z.enum(["shadow", "active"]).default("shadow"),
  /** `on` : la recherche du RAG fusionne le classement dense et le classement lexical FTS5 (SPECS-P5-HYBRID.md) ; éteint = la pile d'avant. */
  hybrid: z.enum(["off", "on"]).default("off"),
  decisionEngine: z.enum(["off", "laya"]).default("off"),
  /** `shadow` : décisions calculées et journalisées, jamais utilisées. */
  decisionMode: z.enum(["shadow", "active"]).default("shadow"),
  /** Journal de décision (`DecisionLogEntry`) ; n'écrit rien tant qu'aucun moteur n'est actif. */
  decisionLog: z.boolean().default(true),
});
export type EcosystemFlags = z.infer<typeof EcosystemFlags>;

export const DEFAULT_ECOSYSTEM_FLAGS: EcosystemFlags = EcosystemFlags.parse({});

/** Lecture tolérante du réglage : une valeur invalide rend la pile actuelle (défauts), jamais une erreur. */
export function ecosystemFlags(raw: unknown): EcosystemFlags {
  const r = EcosystemFlags.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_ECOSYSTEM_FLAGS;
}

// ── Reranker : configuration du worker et journal fantôme (SPECS-P5-RERANKER.md) ───────────────

/**
 * `reranker.json` du profil : le dossier de l'IR à FORMES STATIQUES (lot × longueur figés, produite par `make-static-reranker`),
 * le port FIXE du worker isolé et le lot (nombre de candidats par appel : le NPU ne compile qu'une forme fixe, le lot est celui de l'IR).
 */
export const RerankerConfig = z.strictObject({
  modelDir: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** Candidats par appel : doit être celui avec lequel l'IR a été figée. */
  batch: z.number().int().positive().default(8),
  /** Longueur (tokens) de la paire requête + passage : celle de l'IR figée. */
  maxLength: z.number().int().positive().default(512),
  /** Ordre d'essai (PLAN §7.3) : le premier qui compile ET passe la sonde de parité sert, l'effectif est journalisé. */
  devices: z.array(z.string().min(1)).min(1).default(["NPU", "GPU.0", "CPU"]),
  /**
   * SPECS-P5-RERANKER-PAUSE.md : tant que la voix est active (dictée), aucun reclassement ni lancement du worker. `false` = condition
   * TÉMOIN du banc de contention (comportement d'avant la pause) ; ne sert à rien d'autre.
   */
  voicePriority: z.boolean().default(true),
});
export type RerankerConfig = z.input<typeof RerankerConfig>;

/** Une ligne du rapport fantôme : identifiants de chunks et nombres SEULEMENT (ni requête, ni passage, ni empreinte). */
export const RerankShadowEntry = z.strictObject({
  t: z.number().int().nonnegative(),
  profile: Code,
  engine: EngineInfo,
  ms: z.number().nonnegative(),
  /** `paused` : refusé pendant une dictée (SPECS-P5-RERANKER-PAUSE.md) ; `stale` : reclassement différé abandonné (file pleine, trop vieux…). */
  outcome: z.enum(["ok", "timeout", "unavailable", "error", "paused", "stale"]),
  /** `shadow` (rien servi) ou `active` (le classement a été servi). */
  mode: z.enum(["shadow", "active"]),
  reason: Code.optional(),
  /** Candidats dans l'ordre d'origine (celui du dense servi), puis dans l'ordre du reranker ([] si repli). */
  candidates: z.array(ChunkId),
  reranked: z.array(ChunkId),
  /**
   * Durée TOTALE de la recherche telle que l'appelant la vit (dense + attente éventuelle du reclassement), en ms. Fantôme : le reclassement
   * n'est pas attendu, donc `totalMs` < `ms` ; actif : il l'est, donc `totalMs` ≥ `ms`. Absent d'un rejeu différé (aucune recherche servie)
   * et des lignes écrites avant ce champ (SPECS-P5-RERANKER-ACTIVE.md Q4, barre B). Un nombre, jamais un texte.
   */
  totalMs: z.number().nonnegative().optional(),
});
export type RerankShadowEntry = z.infer<typeof RerankShadowEntry>;

// ── Journal de décision (sans contenu sensible) ─────────────────────────────────────────────────

/**
 * Une ligne du journal. Objet STRICT, champs typés : codes (`Code`, sans espace), nombres, booléens.
 * Aucun champ texte libre, aucune empreinte de l'entrée (le hachage d'un texte court se retrouve par
 * dictionnaire) : ni requête, ni passage, ni état, ni message d'erreur.
 */
export const DecisionLogEntry = z.strictObject({
  /** Horodatage (ms epoch). */
  t: z.number().int().nonnegative(),
  profile: Code,
  stage: z.enum(["vector-index", "embedding", "reranker", "parser", "decision"]),
  engine: EngineInfo,
  /** Génération d'index ou version de schéma de question, si pertinent. */
  generation: z.string().max(512).regex(/^[^\s]*$/).optional(),
  ms: z.number().nonnegative(),
  outcome: z.enum(["ok", "shadow", "fallback", "timeout", "error"]),
  /** Raison du repli ou de l'erreur, en code (`deadline`, `unavailable`, `dim-mismatch`…). */
  reason: Code.optional(),
  /** Comptes : candidats, résultats, chunks, pages… */
  counts: z.record(Code, z.number().int().nonnegative()).optional(),
  /** Décision typée : question du registre et valeur (option du registre, niveau, oui/non, abstention). */
  decision: z
    .strictObject({ question: Code, value: z.union([Code, z.number().int(), z.boolean(), z.null()]), confidence: Probability.optional() })
    .optional(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntry>;
