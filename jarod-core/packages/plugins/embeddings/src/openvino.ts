/**
 * Embeddings exécutés par OpenVINO (PLAN §5.1, gap G5 : « de classer à exécuter »). Jarod-cordis — nouveau.
 *
 * - `openvino-genai-node` (bindings officiels Intel, tokenizer inclus) : aucun Python, aucun serveur.
 * - Le NPU n'accepte que des formes statiques : deux modèles compilés, « requêtes » (128 tokens) et
 *   « documents » (512), choisis d'après la longueur RÉELLE du texte (tokenizer du modèle) — jamais une
 *   troncature silencieuse d'un texte plus long que la forme choisie.
 * - Repli NPU → GPU → CPU (PLAN §7.3) : chaque essai est journalisé avec son erreur, le périphérique
 *   effectif est exposé par `metrics()` — jamais d'échec silencieux.
 * - Repli aussi sur ÉCART NUMÉRIQUE (le NPU calcule en FP16 : compiler juste ≠ calculer juste). Q7
 *   (utilisateur, 2026-09-27) : la métrique est propre aux vecteurs — un périphérique autre que le CPU n'est
 *   retenu que si, sur un jeu de sonde fixe, (1) `1 − cosinus(périphérique, CPU FP32) ≤ 1 %` pour CHAQUE
 *   texte et (2) les `PROBE_TOP_K` voisins de chaque requête sonde sont les mêmes, DANS LE MÊME ORDRE, que
 *   sur le CPU. La règle composante par composante (1 % de l'amplitude) reste celle des spectrogrammes en dB
 *   (`plugin-voice/src/wakeword.ts`), inchangée.
 * - Compilation paresseuse (13-30 s sur NPU) : au premier appel, ou au démarrage si `warmup`.
 * - Sur cette machine, la forme 512 (chunks longs) est refusée par le NPU (`infer_request.cpp:246`) et tourne
 *   sur l'iGPU (GPU.0) : repli ACCEPTÉ pour l'ingestion (décision (d) du 2026-09-29), mesuré sans effet sur
 *   le chat par la gate P4 « chunks longs » (PHASE-4). La forme 128 reste sur le NPU.
 */
import { existsSync } from "node:fs";
import type { EmbeddingsConfig, EmbeddingsMetrics } from "@jarod/contracts";
import type * as Genai from "openvino-genai-node";

type Resolved = Required<Omit<EmbeddingsConfig, "modelDir" | "port">> & Pick<EmbeddingsConfig, "modelDir" | "port">;

/** Chargé au premier usage : les DLL OpenVINO n'ont rien à faire dans un `jarod ask` sans RAG. */
let genai: Promise<typeof Genai> | null = null;
const loadGenai = () => (genai ??= import("openvino-genai-node"));

const WINDOW = 1000;
/** Q7 : `1 − cosinus` toléré entre un périphérique et le CPU, pour chaque texte sonde. */
export const COSINE_TOLERANCE = 0.01;
/** Q7 : nombre de voisins dont l'ordre doit être identique au CPU, pour chaque requête sonde. */
export const PROBE_TOP_K = 5;
/** Requêtes sondes (FR, EN, chiffres, ponctuation) : leurs voisins parmi `PROBE_DOCS` sont comparés au CPU. */
export const PROBE_QUERIES = [
  "Jarod vérifie le NPU : rappelle-moi d'acheter du pain demain matin à huit heures.",
  "Which accelerator runs INT8 neural networks at low power?",
  "Comment planifier une tâche tous les lundis à 9 h ?",
  "Recette des crêpes pour 4 personnes",
];
/** Documents sondes : les mêmes pour toutes les formes, thèmes volontairement distincts. */
export const PROBE_DOCS = [
  "Liste de courses : pain, lait, œufs ; rappel demain à 8 h.",
  "The Intel AI Boost NPU executes quantized INT8 neural networks with very low power draw.",
  "Une expression cron à cinq champs : minute, heure, jour du mois, mois, jour de semaine (0 9 * * 1).",
  "Pâte à crêpes : 250 g de farine, 4 œufs, 50 cl de lait, une pincée de sel.",
  "The quick brown fox jumps over the lazy dog — 0123456789, déjà vu !",
  "Le Piton de la Fournaise, à La Réunion, est l'un des volcans les plus actifs du monde.",
  "SQLite en mode WAL autorise des lectures concurrentes pendant une écriture.",
  "Beethoven a composé la sonate au clair de lune pour piano en 1801.",
];

/** Cosinus de deux vecteurs (sans supposer qu'ils sont normalisés). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/** Indices des `k` documents les plus proches de `q`, du plus proche au moins proche. */
export function topK(q: Float32Array, docs: Float32Array[], k: number): number[] {
  return docs
    .map((d, i) => ({ i, s: cosine(q, d) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .slice(0, k)
    .map((x) => x.i);
}

/** Vecteurs d'une forme compilée sur tout le jeu de sonde : requêtes puis documents. */
async function probeVectors(embed: EmbedFn): Promise<{ queries: Float32Array[]; docs: Float32Array[] }> {
  const queries: Float32Array[] = [];
  const docs: Float32Array[] = [];
  for (const t of PROBE_QUERIES) queries.push(await embed(t));
  for (const t of PROBE_DOCS) docs.push(await embed(t));
  return { queries, docs };
}

/**
 * Compare un périphérique au CPU sur le jeu de sonde (Q7). Rend le compte rendu, ou lève l'écart trouvé.
 * `margin` = plus petit écart de score entre deux voisins consécutifs sur le CPU (pouvoir discriminant de
 * la sonde, journalisé pour lecture ; ce n'est pas un seuil).
 */
export function compareProbe(
  ref: { queries: Float32Array[]; docs: Float32Array[] },
  got: { queries: Float32Array[]; docs: Float32Array[] },
): { gap: number; k: number; margin: number } {
  const all = (v: { queries: Float32Array[]; docs: Float32Array[] }) => [...v.queries, ...v.docs];
  const texts = [...PROBE_QUERIES, ...PROBE_DOCS];
  const r = all(ref);
  const g = all(got);
  let gap = 0;
  for (let n = 0; n < r.length; n++) {
    if (g[n]!.length !== r[n]!.length) throw new Error(`dimension ${g[n]!.length} ≠ ${r[n]!.length} (CPU)`);
    const d = 1 - cosine(r[n]!, g[n]!);
    if (!(d <= COSINE_TOLERANCE)) {
      throw new Error(`1 − cosinus ${d.toPrecision(3)} > ${COSINE_TOLERANCE} vs CPU (sonde « ${texts[n]!.slice(0, 40)} »)`);
    }
    gap = Math.max(gap, d);
  }
  const k = Math.min(PROBE_TOP_K, PROBE_DOCS.length);
  let margin = Infinity;
  for (let q = 0; q < ref.queries.length; q++) {
    const want = topK(ref.queries[q]!, ref.docs, k);
    const have = topK(got.queries[q]!, got.docs, k);
    if (want.join() !== have.join()) {
      throw new Error(`top-${k} différent du CPU pour la requête sonde ${q + 1} : [${have.join(", ")}] ≠ [${want.join(", ")}]`);
    }
    const scores = [...want, ...topK(ref.queries[q]!, ref.docs, k + 1).slice(k)].map((i) => cosine(ref.queries[q]!, ref.docs[i]!));
    for (let i = 1; i < scores.length; i++) margin = Math.min(margin, scores[i - 1]! - scores[i]!);
  }
  return { gap, k, margin };
}

/** Une forme compilée : texte → vecteur. */
export type EmbedFn = (text: string) => Promise<Float32Array>;

/** Ce que l'embedder demande à OpenVINO — remplaçable en test. */
export interface EmbeddingRuntime {
  compile(model: string, device: string, opts: { maxLength: number; pooling: "cls" | "mean"; normalize: boolean }): Promise<EmbedFn>;
  /** Nombre de tokens réels (tokens spéciaux inclus), avec le tokenizer du modèle. */
  tokens(model: string, text: string): Promise<number>;
}

/** Runtime réel : `openvino-genai-node` (TextEmbeddingPipeline + tokenizer natif). */
export function genaiRuntime(): EmbeddingRuntime {
  let tokenizer: { model: string; t: InstanceType<typeof Genai.Tokenizer> } | null = null;
  return {
    async compile(model, device, o) {
      const { PoolingType, TextEmbeddingPipeline } = await loadGenai();
      const pipeline = await TextEmbeddingPipeline(
        model,
        device,
        {
          max_length: o.maxLength,
          pad_to_max_length: true,
          batch_size: 1,
          pooling_type: o.pooling === "cls" ? PoolingType.CLS : PoolingType.MEAN,
          normalize: o.normalize,
        },
        // Pas de cache de compilation : la fabrique 2026.4 ne transmet pas les propriétés OpenVINO.
      );
      return async (text) => {
        const v = await pipeline.embedQuery(text);
        return v instanceof Float32Array ? v : Float32Array.from(v);
      };
    },
    async tokens(model, text) {
      const { Tokenizer } = await loadGenai();
      if (tokenizer?.model !== model) tokenizer = { model, t: new Tokenizer(model) };
      return tokenizer.t.encode(text).input_ids.getShape()[1] ?? 0;
    },
  };
}

export class OpenVinoEmbedder {
  private readonly pipelines = new Map<number, Promise<{ embed: EmbedFn; device: string }>>();
  private readonly effective: Record<string, string> = {};
  private readonly attempts: EmbeddingsMetrics["attempts"] = [];
  private readonly latencies: number[] = [];
  private calls = 0;
  private texts = 0;
  private lastError: string | null = null;
  /** Une inférence à la fois : un NPU ne se partage pas entre deux requêtes concurrentes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: Resolved,
    private readonly log: (line: string) => void = () => {},
    private readonly runtime: EmbeddingRuntime = genaiRuntime(),
  ) {}

  get available(): boolean {
    return Boolean(this.cfg.modelDir && existsSync(this.cfg.modelDir));
  }

  private requireModel(): string {
    if (!this.cfg.modelDir) throw new Error("Embeddings OpenVINO : aucun modèle configuré (modelDir).");
    if (!existsSync(this.cfg.modelDir)) throw new Error(`Embeddings OpenVINO : modèle introuvable (${this.cfg.modelDir}).`);
    return this.cfg.modelDir;
  }

  /** Nombre de tokens réels (tokens spéciaux inclus), avec le tokenizer du modèle. */
  async tokens(text: string): Promise<number> {
    return this.runtime.tokens(this.requireModel(), text);
  }

  private async shapeFor(text: string): Promise<number> {
    return (await this.tokens(text)) <= this.cfg.queryMaxLength ? this.cfg.queryMaxLength : this.cfg.docMaxLength;
  }

  /**
   * Compile la forme demandée sur le premier périphérique qui l'accepte ET calcule juste : hors CPU, les
   * sondes sont comparées à une référence CPU de la même forme (compilée une fois par forme, puis libérée).
   */
  private pipeline(shape: number): Promise<{ embed: EmbedFn; device: string }> {
    let p = this.pipelines.get(shape);
    if (!p) {
      p = (async () => {
        const model = this.requireModel();
        const opts = { maxLength: shape, pooling: this.cfg.pooling, normalize: this.cfg.normalize };
        let reference: Awaited<ReturnType<typeof probeVectors>> | null = null;
        for (const device of this.cfg.devices) {
          const t0 = Date.now();
          try {
            const embed = await this.runtime.compile(model, device, opts);
            let probe: { cosineGap: number; topK: number; margin: number } | undefined;
            if (device !== "CPU") {
              reference ??= await probeVectors(await this.runtime.compile(model, "CPU", opts));
              const { gap, k, margin } = compareProbe(reference, await probeVectors(embed));
              probe = { cosineGap: gap, topK: k, margin };
              this.log(
                `forme ${shape} sur ${device} : 1 − cos max ${gap.toPrecision(3)} ≤ ${COSINE_TOLERANCE}, top-${k} identique au CPU ` +
                  `sur ${PROBE_QUERIES.length} requêtes (marge CPU min ${margin.toPrecision(3)})`,
              );
            }
            this.attempts.push({ shape, device, ok: true, ms: Date.now() - t0, ...(probe && { probe }) });
            this.effective[String(shape)] = device;
            this.log(`forme ${shape} compilée sur ${device} en ${Date.now() - t0} ms`);
            return { embed, device };
          } catch (e) {
            const error = (e as Error).message.split("\n")[0]!;
            this.attempts.push({ shape, device, ok: false, ms: Date.now() - t0, error });
            this.log(`forme ${shape} : ${device} refusé (${error}), essai suivant`);
          }
        }
        throw new Error(`Embeddings OpenVINO : aucun périphérique n'a compilé la forme ${shape} (${this.cfg.devices.join(", ")}).`);
      })();
      this.pipelines.set(shape, p);
      p.catch(() => this.pipelines.delete(shape));
    }
    return p;
  }

  /** Compile les deux formes (démarrage d'un service, pas d'un CLI). */
  async warmup(): Promise<void> {
    await this.pipeline(this.cfg.queryMaxLength);
    await this.pipeline(this.cfg.docMaxLength);
  }

  /** Un vecteur par texte, dans l'ordre. */
  embed(texts: string[]): Promise<Float32Array[]> {
    const run = this.queue.then(async () => {
      const out: Float32Array[] = [];
      try {
        for (const text of texts) {
          const { embed } = await this.pipeline(await this.shapeFor(text));
          const t0 = performance.now();
          const v = await embed(text);
          this.record(performance.now() - t0);
          out.push(v);
        }
        this.calls++;
        this.texts += texts.length;
        return out;
      } catch (e) {
        this.lastError = (e as Error).message;
        throw e;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private record(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > WINDOW) this.latencies.shift();
  }

  metrics(): EmbeddingsMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! : null);
    return {
      available: this.available,
      requested: [...this.cfg.devices],
      device: { ...this.effective },
      attempts: [...this.attempts],
      calls: this.calls,
      texts: this.texts,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      lastError: this.lastError,
    };
  }
}
