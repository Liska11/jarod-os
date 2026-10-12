/**
 * Estimation « le modèle tient-il ? » à partir de l'en-tête GGUF (SPECS-P5-GGUF-FIT.md, piste R1).
 *
 * Principe repris de Magnitude (`design/model-management/assessment-and-ranking.md`, Apache-2.0) : l'en-tête d'un GGUF suffit à calculer le cache KV
 * d'un contexte donné, SANS lire les tenseurs ; le résultat porte un statut honnête — jamais un zéro ni un chiffre inventé. Aucun code de Magnitude n'est repris.
 *
 * Règles de la spec (décisions de l'utilisateur du 2026-10-03) :
 *  - le cache KV est TOUJOURS affiché à part du poids du fichier : un chiffre unique est un échec (Q-FIT5) — le résultat ne porte pas de total isolé,
 *    `renderFit` écrit toujours « poids + KV + état + marge » ;
 *  - aucun accès au GPU ici ; l'écart estimation / mesure sera relevé plus tard, sur le même GGUF et un contexte déclaré (Q-FIT2, Q-FIT4) ;
 *  - une architecture ou une métadonnée inconnue rend `not-estimated`, jamais une valeur par défaut.
 *
 * Mesures réelles qui ont fixé les bornes de lecture (2026-10-02, 4 modèles locaux) : les métadonnées font 5,9 à 10,9 Mo (le vocabulaire en est l'essentiel)
 * mais les clés `general.*` et `<arch>.*` tiennent dans les 4 premiers Ko. On lit donc une FENÊTRE (256 Kio) et on ne l'agrandit que si une clé requise manque.
 */
import { open } from "node:fs/promises";

// ------------------------------------------------------------------------------------------------ lecture de l'en-tête

export type GgufValue = number | bigint | boolean | string | GgufValue[] | { skipped: "array"; length: number };

export type GgufErrorCode = "BAD_MAGIC" | "BAD_VERSION" | "BIG_ENDIAN" | "TRUNCATED_HEADER" | "BAD_TYPE" | "LIMIT";

export class GgufError extends Error {
  constructor(
    readonly code: GgufErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "GgufError";
  }
}

export interface GgufLimits {
  /** Nombre maximal de paires clé-valeur acceptées (un fichier réel en a ~30 à ~80). */
  maxKeys: number;
  /** Longueur maximale d'une chaîne, en octets (un modèle de conversation fait quelques dizaines de Ko). */
  maxStringBytes: number;
  /** Nombre maximal d'éléments d'un tableau. */
  maxArrayElements: number;
  /** Profondeur maximale de tableaux imbriqués. */
  maxDepth: number;
}

export const DEFAULT_GGUF_LIMITS: GgufLimits = { maxKeys: 8192, maxStringBytes: 4 * 1024 * 1024, maxArrayElements: 1 << 24, maxDepth: 2 };

export interface GgufMetadata {
  version: number;
  tensorCount: bigint;
  /** Nombre de paires annoncé par l'en-tête (peut dépasser le nombre lu si la fenêtre est tronquée). */
  declaredKeys: number;
  /** Paires lues, dans l'ordre du fichier. Les gros tableaux (vocabulaire) ne sont PAS gardés : `{ skipped: "array", length }`. */
  kv: Map<string, GgufValue>;
  /** Toutes les paires annoncées ont été lues : l'en-tête de métadonnées tenait dans la fenêtre. */
  complete: boolean;
  /** Octets consommés dans la fenêtre. */
  bytesRead: number;
}

const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const KEEP_ARRAY_UP_TO = 64;

class Truncated extends Error {}

class Reader {
  private readonly view: DataView;
  pos = 0;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.byteLength) throw new Truncated();
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  scalar(type: number): number | bigint | boolean {
    this.need(FIXED_SIZE[type]!);
    let v: number | bigint | boolean;
    switch (type) {
      case 0: v = this.view.getUint8(this.pos); break;
      case 1: v = this.view.getInt8(this.pos); break;
      case 2: v = this.view.getUint16(this.pos, true); break;
      case 3: v = this.view.getInt16(this.pos, true); break;
      case 4: v = this.view.getUint32(this.pos, true); break;
      case 5: v = this.view.getInt32(this.pos, true); break;
      case 6: v = this.view.getFloat32(this.pos, true); break;
      case 7: v = this.view.getUint8(this.pos) !== 0; break;
      case 10: v = this.view.getBigUint64(this.pos, true); break;
      case 11: v = this.view.getBigInt64(this.pos, true); break;
      default: v = this.view.getFloat64(this.pos, true);
    }
    this.pos += FIXED_SIZE[type]!;
    return v;
  }
  string(maxBytes: number): string {
    const len = this.u64();
    if (len > BigInt(maxBytes)) throw new GgufError("LIMIT", `chaîne de ${len} octets (plafond ${maxBytes})`);
    const n = Number(len);
    this.need(n);
    const s = new TextDecoder("utf-8", { fatal: false }).decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

function readValue(r: Reader, type: number, lim: GgufLimits, depth: number): GgufValue {
  if (type in FIXED_SIZE) return normalize(r.scalar(type));
  if (type === 8) return r.string(lim.maxStringBytes);
  if (type === 9) {
    if (depth >= lim.maxDepth) throw new GgufError("LIMIT", `tableaux imbriqués au-delà de ${lim.maxDepth} niveaux`);
    const elemType = r.u32();
    const len = r.u64();
    if (len > BigInt(lim.maxArrayElements)) throw new GgufError("LIMIT", `tableau de ${len} éléments (plafond ${lim.maxArrayElements})`);
    const n = Number(len);
    if (elemType !== 8 && elemType !== 9 && !(elemType in FIXED_SIZE)) throw new GgufError("BAD_TYPE", `type d'élément de tableau ${elemType}`);
    if (n <= KEEP_ARRAY_UP_TO) {
      const out: GgufValue[] = [];
      for (let i = 0; i < n; i++) out.push(readValue(r, elemType, lim, depth + 1));
      return out;
    }
    if (elemType in FIXED_SIZE) r.skip(n * FIXED_SIZE[elemType]!);
    else for (let i = 0; i < n; i++) readValue(r, elemType, lim, depth + 1); // chaque tour consomme au moins 8 octets : borné par la fenêtre
    return { skipped: "array", length: n };
  }
  throw new GgufError("BAD_TYPE", `type de valeur ${type}`);
}

/** Entiers 64 bits → nombre quand il est sûr, sinon on garde le `bigint` (jamais d'arrondi silencieux). */
function normalize(v: number | bigint | boolean): number | bigint | boolean {
  if (typeof v === "bigint" && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return v;
}

/**
 * Analyse l'en-tête GGUF contenu dans `buf` (le début du fichier). Tolère une fenêtre TRONQUÉE au milieu des métadonnées (`complete: false`, les paires
 * entièrement lues sont rendues) ; rejette tout le reste : magie fausse, version inconnue, fichier gros-boutiste, type inconnu, dépassement d'un plafond.
 */
export function parseGgufMetadata(buf: Uint8Array, limits: Partial<GgufLimits> = {}): GgufMetadata {
  const lim = { ...DEFAULT_GGUF_LIMITS, ...limits };
  if (buf.byteLength < 4 || buf[0] !== 0x47 || buf[1] !== 0x47 || buf[2] !== 0x55 || buf[3] !== 0x46)
    throw new GgufError("BAD_MAGIC", "le fichier ne commence pas par « GGUF »");
  const r = new Reader(buf);
  r.skip(4);
  let version: number;
  let tensorCount: bigint;
  let declared: bigint;
  try {
    version = r.u32();
    if (version > 0xffff) throw new GgufError("BIG_ENDIAN", "fichier GGUF gros-boutiste (non pris en charge)");
    if (version !== 3) throw new GgufError("BAD_VERSION", `version ${version} (seule la version 3 est prise en charge)`);
    tensorCount = r.u64();
    declared = r.u64();
  } catch (e) {
    if (e instanceof Truncated) throw new GgufError("TRUNCATED_HEADER", "fenêtre trop courte pour lire l'en-tête fixe (24 octets)");
    throw e;
  }
  if (declared > BigInt(lim.maxKeys)) throw new GgufError("LIMIT", `${declared} paires annoncées (plafond ${lim.maxKeys})`);
  const kv = new Map<string, GgufValue>();
  let complete = true;
  let consumed = r.pos; // ne compte que les paires ENTIÈRES
  try {
    for (let i = 0n; i < declared; i++) {
      const key = r.string(lim.maxStringBytes);
      const type = r.u32();
      kv.set(key, readValue(r, type, lim, 0));
      consumed = r.pos;
    }
  } catch (e) {
    if (!(e instanceof Truncated)) throw e;
    complete = false;
  }
  return { version, tensorCount, declaredKeys: Number(declared), kv, complete, bytesRead: consumed };
}

/** Fenêtre de lecture initiale et plafond (la spec fixe un plafond ; la valeur 16 Mio couvre les 10,9 Mo mesurés). */
export const GGUF_WINDOW_BYTES = 256 * 1024;
export const GGUF_MAX_READ_BYTES = 16 * 1024 * 1024;

/**
 * Une SOURCE D'OCTETS : le début d'un fichier GGUF lu par tranches. Le fichier local (`readGgufFile`) et la lecture HTTP `Range` (`gguf-range.ts`) la
 * satisfont ; la boucle « fenêtre → analyse → doubler » (`readGgufSource`) est la même pour les deux.
 */
export interface GgufByteSource {
  /** Lit `length` octets à partir de `offset` (moins s'il n'y en a plus) ; `total` = taille du fichier ENTIER, jamais celle de la tranche. */
  read(offset: number, length: number): Promise<{ bytes: Uint8Array; total: number }>;
}

/**
 * Lit l'en-tête GGUF d'une source : fenêtre de 256 Kio, doublée seulement si une clé requise manque, jamais au-delà de `maxBytes`. Ne lit JAMAIS les
 * tenseurs. Les octets déjà lus ne sont pas relus : chaque doublement ne demande que la tranche suivante. `required` : clés dont l'absence justifie
 * d'élargir la fenêtre.
 */
export async function readGgufSource(
  source: GgufByteSource,
  opts: { windowBytes?: number; maxBytes?: number; required?: (kv: Map<string, GgufValue>) => boolean; limits?: Partial<GgufLimits> } = {},
): Promise<{ metadata: GgufMetadata; fileBytes: number; windowBytes: number }> {
  const maxBytes = opts.maxBytes ?? GGUF_MAX_READ_BYTES;
  let window = Math.min(opts.windowBytes ?? GGUF_WINDOW_BYTES, maxBytes);
  let buf = new Uint8Array(0);
  for (;;) {
    const { bytes, total } = await source.read(buf.length, window - buf.length);
    if (bytes.length > 0) {
      const next = new Uint8Array(buf.length + bytes.length);
      next.set(buf);
      next.set(bytes, buf.length);
      buf = next;
    }
    const metadata = parseGgufMetadata(buf, opts.limits);
    const enough = metadata.complete || (opts.required ? opts.required(metadata.kv) : hasArchitectureKeys(metadata.kv));
    // `bytes.length === 0` : plus rien à lire (fin de fichier ou source à court) — rendre ce qu'on a plutôt que boucler.
    if (enough || window >= maxBytes || buf.length >= total || bytes.length === 0) return { metadata, fileBytes: total, windowBytes: buf.length };
    window = Math.min(window * 2, maxBytes);
  }
}

/**
 * Lit le début d'un fichier `.gguf` local (lecture seule) : fenêtre de 256 Kio, doublée seulement si une clé requise manque, jamais au-delà de
 * `maxBytes`. Ne lit JAMAIS les tenseurs. `required` : clés dont l'absence justifie d'élargir la fenêtre.
 */
export async function readGgufFile(
  path: string,
  opts: { windowBytes?: number; maxBytes?: number; required?: (kv: Map<string, GgufValue>) => boolean; limits?: Partial<GgufLimits> } = {},
): Promise<{ metadata: GgufMetadata; fileBytes: number; windowBytes: number }> {
  const fh = await open(path, "r");
  try {
    const total = (await fh.stat()).size;
    return await readGgufSource(
      {
        async read(offset, length) {
          const buf = new Uint8Array(Math.max(0, Math.min(length, total - offset)));
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          return { bytes: buf.subarray(0, bytesRead), total };
        },
      },
      opts,
    );
  } finally {
    await fh.close();
  }
}

/** La fenêtre contient l'architecture ET au moins une clé de cette architecture (les clés `<arch>.*` suivent `general.*`). */
function hasArchitectureKeys(kv: Map<string, GgufValue>): boolean {
  const arch = kv.get("general.architecture");
  if (typeof arch !== "string") return false;
  for (const k of kv.keys()) if (k.startsWith(`${arch}.block_count`)) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------ estimation

export type KvType = "f32" | "f16" | "bf16" | "q8_0" | "q5_1" | "q5_0" | "q4_1" | "q4_0";

/** Octets par élément (taille d'un bloc quantifié / 32 éléments). */
export const KV_BYTES_PER_ELEMENT: Record<KvType, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
};

/**
 * Marge de tampons de calcul : constante PROVISOIRE et NOMMÉE (pas un `×1,2` caché). Elle n'a pas encore été mesurée ; elle le sera au créneau de mesure
 * (Q-FIT3, même GGUF, contexte déclaré). Toujours affichée à part.
 */
export const PROVISIONAL_COMPUTE_HEADROOM_BYTES = 1024 ** 3;

export interface FitOptions {
  /** Cellules de cache allouées (équivalent de `-c` de llama-server). Entier ≥ 1. */
  contextTokens: number;
  /** Taille du fichier `.gguf` : le poids v1 (aucune décharge partielle sur le CPU). */
  fileBytes: number;
  kvTypeK?: KvType;
  kvTypeV?: KvType;
  /** Séquences simultanées : multiplie l'état récurrent (le cache KV unifié est compté une fois). Défaut 1. */
  parallelSlots?: number;
  /** Mémoire disponible sur le GPU, en octets ; absent = pas de décision `fits` / `does-not-fit`. */
  gpuBytes?: number | null;
  /** Remplace la marge provisoire. */
  headroomBytes?: number;
}

export type FitStatus = "fits" | "does-not-fit" | "estimated" | "beyond-native-context" | "not-estimated";

export interface FitBreakdown {
  weightsBytes: number;
  /** Cache KV des couches d'attention, pour `contextTokens`. */
  kvBytes: number;
  /** État récurrent (couches SSM) ; 0 pour une architecture sans couche récurrente. */
  stateBytes: number;
  headroomBytes: number;
}

export interface FitResult {
  status: FitStatus;
  /** Pourquoi `not-estimated` / `beyond-native-context`. */
  reason?: string;
  architecture: string | null;
  contextTokens: number;
  nativeContextTokens: number | null;
  totalLayers: number | null;
  attentionLayers: number | null;
  kvBytesPerToken: number | null;
  /** Toujours présent sauf `not-estimated` : le KV est séparé du poids, jamais fondu dans un total unique. */
  breakdown: FitBreakdown | null;
  /** Hypothèses non vérifiées dont dépend le résultat (à confirmer au créneau de mesure). */
  assumptions: string[];
}

/** Architectures prises en charge en v1 : attention standard à têtes groupées. */
const STANDARD_ARCHS = new Set(["llama", "qwen2", "qwen3", "qwen3moe"]);

const notEstimated = (arch: string | null, ctx: number, reason: string, native: number | null = null): FitResult => ({
  status: "not-estimated",
  reason,
  architecture: arch,
  contextTokens: ctx,
  nativeContextTokens: native,
  totalLayers: null,
  attentionLayers: null,
  kvBytesPerToken: null,
  breakdown: null,
  assumptions: [],
});

function posInt(v: GgufValue | undefined): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export function estimateGgufMemory(meta: Pick<GgufMetadata, "kv">, opts: FitOptions): FitResult {
  const ctx = opts.contextTokens;
  const arch = meta.kv.get("general.architecture");
  if (!Number.isInteger(ctx) || ctx < 1) return notEstimated(typeof arch === "string" ? arch : null, ctx, "contexte demandé invalide (entier ≥ 1 attendu)");
  if (!Number.isFinite(opts.fileBytes) || opts.fileBytes <= 0) return notEstimated(typeof arch === "string" ? arch : null, ctx, "taille de fichier invalide");
  if (typeof arch !== "string") return notEstimated(null, ctx, "`general.architecture` absente de l'en-tête lu");
  const get = (k: string) => meta.kv.get(`${arch}.${k}`);
  // L'architecture d'abord : une architecture inconnue ne doit pas être refusée pour une clé « manquante » qu'elle n'a peut-être pas à porter.
  if (!STANDARD_ARCHS.has(arch) && arch !== "qwen35")
    return notEstimated(arch, ctx, `architecture « ${arch} » non prise en charge (v1 : ${[...STANDARD_ARCHS, "qwen35"].join(", ")})`, posInt(get("context_length")));

  const layers = posInt(get("block_count"));
  const native = posInt(get("context_length"));
  const heads = posInt(get("attention.head_count"));
  const embd = posInt(get("embedding_length"));
  if (!layers) return notEstimated(arch, ctx, `${arch}.block_count absente ou invalide`, native);
  if (!heads) return notEstimated(arch, ctx, `${arch}.attention.head_count absente ou illisible (tableau par couche non pris en charge)`, native);

  const kvHeadsRaw = get("attention.head_count_kv");
  if (Array.isArray(kvHeadsRaw)) return notEstimated(arch, ctx, `${arch}.attention.head_count_kv est un tableau par couche (non pris en charge)`, native);
  const kvHeads = kvHeadsRaw === undefined ? heads : posInt(kvHeadsRaw);
  if (!kvHeads) return notEstimated(arch, ctx, `${arch}.attention.head_count_kv invalide`, native);

  const keyLen = posInt(get("attention.key_length")) ?? (embd ? Math.floor(embd / heads) : null);
  const valLen = posInt(get("attention.value_length")) ?? keyLen;
  if (!keyLen || !valLen) return notEstimated(arch, ctx, "longueur des têtes K/V introuvable (ni `attention.key_length`, ni `embedding_length`)", native);

  const assumptions: string[] = [];
  let attentionLayers: number;
  let stateBytesPerSeq = 0;

  if (STANDARD_ARCHS.has(arch)) {
    attentionLayers = layers;
  } else if (arch === "qwen35") {
    const interval = posInt(get("full_attention_interval"));
    if (!interval) return notEstimated(arch, ctx, "qwen35.full_attention_interval absente ou invalide", native);
    // Une couche sur `interval` est une attention complète ; les autres sont récurrentes (état de taille constante).
    attentionLayers = Math.floor(layers / interval);
    const inner = posInt(get("ssm.inner_size"));
    const stateSize = posInt(get("ssm.state_size"));
    const groups = posInt(get("ssm.group_count"));
    const conv = posInt(get("ssm.conv_kernel"));
    if (!inner || !stateSize || !groups || !conv) return notEstimated(arch, ctx, "clés `qwen35.ssm.*` manquantes : état récurrent non calculable", native);
    const recurrentLayers = layers - attentionLayers;
    // Par couche : état (inner × state_size) + tampon de convolution ((noyau − 1) × (inner + 2 × groupes × state_size)), en f32.
    const perLayer = (inner * stateSize + (conv - 1) * (inner + 2 * groups * stateSize)) * 4;
    stateBytesPerSeq = recurrentLayers * perLayer;
    assumptions.push("état récurrent qwen35 : formule déduite de l'architecture (états f32), non vérifiée sur llama.cpp ; ordre de grandeur ≈ 50 Mio par séquence");
    const nextn = posInt(get("nextn_predict_layers"));
    if (nextn) {
      // Mesuré sur les en-têtes locaux (2026-10-03) : un Qwen3.8-27B annonce `block_count` = 65 avec `nextn_predict_layers` = 1 (64 couches + 1 couche MTP).
      assumptions.push(
        `${nextn} couche(s) de prédiction MTP (${arch}.nextn_predict_layers) comptée(s) dans block_count mais NON ajoutée(s) aux couches d'attention : si elle garde un cache KV, le cache est sous-estimé d'environ 1/${attentionLayers} (${attentionLayers} → ${attentionLayers + nextn} couches), à vérifier par la mesure`,
      );
    }
  } else {
    // Inatteignable : l'architecture a été filtrée plus haut ; gardé pour qu'un ajout futur à la liste ne tombe pas dans le silence.
    return notEstimated(arch, ctx, `architecture « ${arch} » sans formule de cache`, native);
  }

  const bytesK = KV_BYTES_PER_ELEMENT[opts.kvTypeK ?? "f16"];
  const bytesV = KV_BYTES_PER_ELEMENT[opts.kvTypeV ?? "f16"];
  const kvPerToken = attentionLayers * kvHeads * (keyLen * bytesK + valLen * bytesV);
  const kvBytes = Math.round(kvPerToken * ctx);
  const slots = Math.max(1, Math.floor(opts.parallelSlots ?? 1));
  const breakdown: FitBreakdown = {
    weightsBytes: opts.fileBytes,
    kvBytes,
    stateBytes: stateBytesPerSeq * slots,
    headroomBytes: opts.headroomBytes ?? PROVISIONAL_COMPUTE_HEADROOM_BYTES,
  };
  if (opts.headroomBytes === undefined) assumptions.push("marge de tampons de calcul provisoire (1 Gio), non mesurée");
  assumptions.push("poids = taille du fichier (aucune décharge partielle sur le CPU) ; cache KV compté UNE fois pour `contextTokens` (KV unifié de llama-server : à confirmer par la mesure)");

  const base = { architecture: arch, contextTokens: ctx, nativeContextTokens: native, totalLayers: layers, attentionLayers, kvBytesPerToken: kvPerToken, breakdown, assumptions };
  if (native !== null && ctx > native) {
    return { ...base, status: "beyond-native-context", reason: `contexte demandé (${ctx}) supérieur au contexte natif du modèle (${native}) : cache KV calculé et affiché, tenue non affirmée` };
  }
  const total = breakdown.weightsBytes + breakdown.kvBytes + breakdown.stateBytes + breakdown.headroomBytes;
  if (opts.gpuBytes === undefined || opts.gpuBytes === null) return { ...base, status: "estimated" };
  return { ...base, status: total <= opts.gpuBytes ? "fits" : "does-not-fit" };
}

// ------------------------------------------------------------------------------------------------ depuis un fichier, et le contexte maximal

/** Vrai quand la fenêtre lue suffit à l'estimateur : architecture non prise en charge (rien de plus à attendre) ou toutes ses clés présentes. */
function enoughForFit(kv: Map<string, GgufValue>): boolean {
  const arch = kv.get("general.architecture");
  if (typeof arch !== "string") return false;
  if (!STANDARD_ARCHS.has(arch) && arch !== "qwen35") return true;
  return estimateGgufMemory({ kv }, { contextTokens: 1, fileBytes: 1 }).status !== "not-estimated";
}

/**
 * Lit l'en-tête pour l'estimateur ; une erreur devient un résultat `not-estimated` (jamais une exception) — un en-tête hostile ou illisible est « non estimé ».
 * Pour une SOURCE (lecture distante), une panne de transport (réseau, 429, `Range` ignoré…) n'est PAS « non estimé » : elle est relancée, l'appelant dit
 * « non vérifié » (état distinct, spec § 3.1 de SPECS-P5-MODELS.md).
 */
async function readForFit(input: string | GgufByteSource, contextTokens: number): Promise<{ metadata: GgufMetadata; fileBytes: number } | { failed: FitResult }> {
  try {
    const { metadata, fileBytes } =
      typeof input === "string" ? await readGgufFile(input, { required: enoughForFit }) : await readGgufSource(input, { required: enoughForFit });
    return { metadata, fileBytes };
  } catch (e) {
    if (e instanceof GgufError) return { failed: notEstimated(null, contextTokens, e.message) };
    if (typeof input !== "string") throw e;
    return { failed: notEstimated(null, contextTokens, `fichier illisible (${(e as NodeJS.ErrnoException).code ?? "erreur de lecture"})`) };
  }
}

/**
 * Estimation pour un fichier `.gguf` local : lit l'en-tête (fenêtre élargie seulement tant qu'une clé de l'estimateur manque), mesure la taille du
 * fichier, rend le résultat. NE JETTE JAMAIS : un fichier absent, illisible, hostile ou tronqué donne `not-estimated` avec la raison — jamais un
 * chiffre inventé (règle de la spec).
 */
export async function estimateGgufFile(path: string | GgufByteSource, opts: Omit<FitOptions, "fileBytes">): Promise<{ fit: FitResult; fileBytes: number | null }> {
  const r = await readForFit(path, opts.contextTokens);
  if ("failed" in r) return { fit: r.failed, fileBytes: null };
  return { fit: estimateGgufMemory(r.metadata, { ...opts, fileBytes: r.fileBytes }), fileBytes: r.fileBytes };
}

export interface MaxContext {
  /** Le plus grand contexte (en jetons) qui tient dans `gpuBytes` ; `null` quand on ne peut pas ou qu'aucun contexte ne tient. */
  contextTokens: number | null;
  /** Ce qui borne le résultat : la mémoire, ou le contexte natif du modèle. */
  limitedBy: "memory" | "native-context" | null;
  /** Pourquoi `contextTokens` est `null`. */
  reason?: string;
}

/**
 * Le plus grand contexte qui tient dans `gpuBytes` — l'INVERSE de `estimateGgufMemory`, avec les mêmes hypothèses : poids + état + marge fixes, cache KV
 * proportionnel au contexte. Jamais au-delà du contexte natif. Un contexte rendu ici est `fits` pour l'estimateur ; le suivant ne l'est plus (propriété testée).
 */
export function maxContextThatFits(meta: Pick<GgufMetadata, "kv">, opts: Omit<FitOptions, "contextTokens" | "gpuBytes"> & { gpuBytes: number }): MaxContext {
  const probe = estimateGgufMemory(meta, { ...opts, contextTokens: 1, gpuBytes: null });
  if (!probe.breakdown || probe.kvBytesPerToken === null) return { contextTokens: null, limitedBy: null, reason: probe.reason ?? "non estimé" };
  if (!Number.isFinite(opts.gpuBytes) || opts.gpuBytes <= 0) return { contextTokens: null, limitedBy: null, reason: "mémoire disponible inconnue" };
  const b = probe.breakdown;
  const room = opts.gpuBytes - b.weightsBytes - b.stateBytes - b.headroomBytes;
  if (room <= 0) return { contextTokens: null, limitedBy: null, reason: "le poids du modèle, son état et la marge dépassent déjà la mémoire disponible" };
  const native = probe.nativeContextTokens;
  let byMemory = probe.kvBytesPerToken === 0 ? Number.POSITIVE_INFINITY : Math.floor(room / probe.kvBytesPerToken);
  // `estimateGgufMemory` arrondit le cache à l'octet : on recule d'un jeton tant que l'arrondi fait dépasser (au plus une ou deux fois).
  while (Number.isFinite(byMemory) && byMemory >= 1 && Math.round(probe.kvBytesPerToken * byMemory) > room) byMemory -= 1;
  if (byMemory < 1) return { contextTokens: null, limitedBy: null, reason: "même un contexte d'un jeton ne tient pas" };
  if (native !== null && byMemory >= native) return { contextTokens: native, limitedBy: "native-context" };
  if (!Number.isFinite(byMemory)) return { contextTokens: null, limitedBy: null, reason: "contexte natif du modèle inconnu et cache sans croissance : non borné" };
  return { contextTokens: byMemory, limitedBy: "memory" };
}

/** Ce que le rapport ne couvre PAS (codes, pour que l'écran les traduise) : chacun est une hypothèse qui peut fausser le résultat. */
export type FitNote = "partial-offload" | "draft-model-not-counted" | "parallel-slots-default";

export interface FitReport {
  fit: FitResult;
  fileBytes: number | null;
  /** `null` : pas de mémoire connue, décharge partielle, ou estimation impossible (voir `fit.reason` / `notes`). */
  maxContext: MaxContext | null;
  notes: FitNote[];
}

/**
 * Le rapport complet d'UN préréglage de llama-server, en une lecture d'en-tête : estimation au contexte demandé, contexte maximal qui tient, et la liste des
 * hypothèses non couvertes. Décharge PARTIELLE sur le CPU (`gpuLayers` ≥ 0 et < nombre de couches) : le poids n'est plus tout en mémoire de calcul, donc
 * AUCUN verdict `fits` / `does-not-fit` et aucun contexte maximal (le cache KV reste calculé et affiché) ; le brouillon (décodage spéculatif) n'est pas compté.
 */
export async function reportGgufFit(path: string | GgufByteSource, opts: ReportOptions): Promise<FitReport> {
  const r = await readForFit(path, opts.contextTokens);
  if ("failed" in r) return { fit: r.failed, fileBytes: null, maxContext: null, notes: reportNotes(opts) };
  return fitReportFromMetadata(r.metadata, r.fileBytes, opts);
}

/** Les options d'un rapport : le contexte demandé et les réglages du préréglage. */
export interface ReportOptions {
  contextTokens: number;
  cacheType?: KvType;
  parallelSlots?: number | null;
  gpuBytes?: number | null;
  gpuLayers?: number;
  draftModel?: boolean;
}

function reportNotes(opts: ReportOptions): FitNote[] {
  const notes: FitNote[] = [];
  if (opts.draftModel) notes.push("draft-model-not-counted");
  if (opts.parallelSlots === null || opts.parallelSlots === undefined) notes.push("parallel-slots-default");
  return notes;
}

/**
 * Le rapport d'un en-tête DÉJÀ lu (fichier local, lecture `Range` ou entrée du cache d'analyse) : même calcul que `reportGgufFit`, extrait pour que le verdict soit le
 * MÊME quelle que soit la provenance des métadonnées (SPECS-P5-MODELS.md § 3.10 (c)). `fileBytes` est le poids : la taille du fichier, ou la SOMME des fragments d'un modèle découpé.
 */
export function fitReportFromMetadata(metadata: Pick<GgufMetadata, "kv">, fileBytes: number, opts: ReportOptions): FitReport {
  const notes = reportNotes(opts);
  const base = {
    fileBytes,
    ...(opts.cacheType ? { kvTypeK: opts.cacheType, kvTypeV: opts.cacheType } : {}),
    parallelSlots: opts.parallelSlots ?? 1,
  };
  const probe = estimateGgufMemory(metadata, { ...base, contextTokens: opts.contextTokens });
  const partial = opts.gpuLayers !== undefined && opts.gpuLayers >= 0 && probe.totalLayers !== null && opts.gpuLayers < probe.totalLayers;
  if (partial) notes.push("partial-offload");
  const gpu = !partial && typeof opts.gpuBytes === "number" && opts.gpuBytes > 0 ? opts.gpuBytes : null;
  const fit = gpu === null ? probe : estimateGgufMemory(metadata, { ...base, contextTokens: opts.contextTokens, gpuBytes: gpu });
  return { fit, fileBytes, maxContext: gpu === null ? null : maxContextThatFits(metadata, { ...base, gpuBytes: gpu }), notes };
}

/** Le rapport d'un en-tête ILLISIBLE (hostile, tronqué, mauvais magic) : « non estimé » avec la raison, jamais une exception ni un chiffre inventé. */
export function unreadableFitReport(reason: string, opts: ReportOptions): FitReport {
  return { fit: notEstimated(null, opts.contextTokens, reason), fileBytes: null, maxContext: null, notes: reportNotes(opts) };
}

/**
 * Lit l'en-tête d'une SOURCE pour l'estimateur (fenêtre élargie seulement tant qu'une clé de l'estimateur manque). Un en-tête illisible (`GgufError`) rend `{ unreadable }` —
 * un résultat déterministe pour ce fichier ; une panne de TRANSPORT (réseau, 429, `Range` ignoré…) est relancée : l'appelant dit « non vérifié ».
 */
export async function readGgufForFit(source: GgufByteSource, opts: { maxBytes?: number } = {}): Promise<{ metadata: GgufMetadata; fileBytes: number } | { unreadable: string }> {
  try {
    const { metadata, fileBytes } = await readGgufSource(source, { required: enoughForFit, ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }) });
    return { metadata, fileBytes };
  } catch (e) {
    if (e instanceof GgufError) return { unreadable: e.message };
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ affichage

const GIB = 1024 ** 3;
const fmt = (n: number) => `${(n / GIB).toFixed(2)} Gio`;

/** Texte d'affichage : le KV est TOUJOURS une ligne à part, jamais fondu dans un total unique. */
export function renderFit(r: FitResult): string {
  if (!r.breakdown) return `non estimé — ${r.reason ?? "raison inconnue"}`;
  const b = r.breakdown;
  const total = b.weightsBytes + b.kvBytes + b.stateBytes + b.headroomBytes;
  const lines = [
    `poids du fichier : ${fmt(b.weightsBytes)}`,
    `cache KV (${r.contextTokens} jetons${r.attentionLayers !== null && r.totalLayers !== null ? `, ${r.attentionLayers}/${r.totalLayers} couches d'attention` : ""}) : ${fmt(b.kvBytes)}`,
    `état récurrent : ${fmt(b.stateBytes)}`,
    `marge de calcul (provisoire) : ${fmt(b.headroomBytes)}`,
    `somme : ${fmt(total)}`,
  ];
  if (r.reason) lines.push(r.reason);
  return lines.join("\n");
}
