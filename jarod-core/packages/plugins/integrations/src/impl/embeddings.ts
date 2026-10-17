/**
 * B1 (transformers.js) — embeddings dans le paquet installé, et B2 (sqlite-vec) — recherche vectorielle.
 *
 * B1 : aucun poids n'est téléchargé sans l'accord de l'utilisateur ; les poids sont épinglés par SHA-256 (un fichier
 * qui ne correspond pas est refusé et jamais chargé) ; la dimension rendue par le moteur est contrôlée.
 * B2 : le chargement de l'extension native est un PoC d'ABI (`probe`) ; s'il échoue, l'index se replie sur un calcul
 * exact en mémoire, et le dit (`kind`). Un faux « sqlite-vec chargé » est impossible : `kind` vient du résultat du probe.
 */
import { AdapterRefused, AdapterUnavailable, need, sha256 } from "./common.js";

export interface ModelPin {
  id: string;
  sha256: string;
  sizeBytes: number;
  dimensions: number;
}

export interface EmbeddingBackend {
  /** Charge des poids déjà vérifiés ; rend le moteur prêt. */
  load(weights: Uint8Array, pin: ModelPin): Promise<void>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingsDeps {
  backend?: EmbeddingBackend;
  /** Rend les octets des poids : depuis le disque si présents (installation empaquetée), sinon téléchargés. */
  fetchWeights?(pin: ModelPin, mode: "installed" | "download"): Promise<Uint8Array | null>;
  /** Demande l'accord de l'utilisateur AVANT tout téléchargement. */
  consent?(pin: ModelPin): Promise<boolean>;
}

export class Embeddings {
  private ready = false;
  constructor(private readonly pin: ModelPin, private readonly deps: EmbeddingsDeps) {}

  /** Charge le modèle : d'abord ce qui est installé ; sinon seulement avec accord. Les poids doivent correspondre à l'épingle. */
  async ensureLoaded(): Promise<"installed" | "downloaded"> {
    const backend = need("B1", this.deps.backend);
    const fetchWeights = need("B1", this.deps.fetchWeights, "aucune source de poids");
    let source: "installed" | "downloaded" = "installed";
    let weights = await fetchWeights(this.pin, "installed");
    if (!weights) {
      if (!(await (this.deps.consent?.(this.pin) ?? false))) throw new AdapterRefused("B1", "poids absents et téléchargement non accordé");
      weights = await fetchWeights(this.pin, "download");
      source = "downloaded";
    }
    if (!weights) throw new AdapterUnavailable("B1", "poids introuvables");
    if (weights.byteLength !== this.pin.sizeBytes || sha256(weights) !== this.pin.sha256) throw new AdapterRefused("B1", "les poids ne correspondent pas à l'épingle (taille ou SHA-256)");
    await backend.load(weights, this.pin);
    this.ready = true;
    return source;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.ready) throw new AdapterUnavailable("B1", "modèle non chargé");
    if (!texts.length) return [];
    const out = await need("B1", this.deps.backend).embed(texts);
    if (out.length !== texts.length || out.some((v) => v.length !== this.pin.dimensions || v.some((x) => !Number.isFinite(x)))) throw new AdapterRefused("B1", "le moteur a rendu des vecteurs invalides (nombre, dimension ou valeur)");
    return out;
  }
}

// ---------------------------------------------------------------- B2

export interface VecHit {
  id: string;
  score: number;
}

export interface VecIndex {
  kind: "sqlite-vec" | "memory";
  add(id: string, vector: number[]): void;
  search(vector: number[], k: number): VecHit[];
  remove(id: string): void;
  size(): number;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Repli exact : calcul brut en mémoire. */
export class MemoryIndex implements VecIndex {
  readonly kind = "memory" as const;
  private readonly rows = new Map<string, number[]>();
  constructor(private readonly dimensions: number) {}
  add(id: string, vector: number[]): void {
    if (vector.length !== this.dimensions) throw new AdapterRefused("B2", `dimension ${vector.length} ≠ ${this.dimensions}`);
    this.rows.set(id, vector);
  }
  search(vector: number[], k: number): VecHit[] {
    if (vector.length !== this.dimensions) throw new AdapterRefused("B2", `dimension ${vector.length} ≠ ${this.dimensions}`);
    return [...this.rows].map(([id, v]) => ({ id, score: cosine(vector, v) })).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, Math.max(0, k));
  }
  remove(id: string): void {
    this.rows.delete(id);
  }
  size(): number {
    return this.rows.size;
  }
}

export interface VecExtension {
  /** PoC d'ABI : charge l'extension dans la base chiffrée et rend sa version, ou lève. */
  probe(): { version: string };
  open(dimensions: number): VecIndex;
}

/** sqlite-vec si le PoC d'ABI réussit, sinon le repli exact. `reason` dit pourquoi le repli. */
export function openVecIndex(dimensions: number, ext?: VecExtension): { index: VecIndex; reason?: string } {
  if (!ext) return { index: new MemoryIndex(dimensions), reason: "extension non branchée" };
  try {
    const { version } = ext.probe();
    if (!version) throw new Error("version vide");
    const index = ext.open(dimensions);
    return { index: Object.assign(index, { kind: "sqlite-vec" as const }) };
  } catch (e) {
    return { index: new MemoryIndex(dimensions), reason: `PoC d'ABI échoué : ${(e as Error).message.slice(0, 120)}` };
  }
}
