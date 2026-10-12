/**
 * Cache d'analyse des en-têtes GGUF distants (SPECS-P5-MODELS.md § 3.6 « Cache local » et § 3.10 (b)) : une lecture d'en-tête n'est JAMAIS refaite pour la même clé.
 *
 *  - clé = `(repo, sha épinglé, fichier, taille du fichier lu)` : une entrée s'invalide quand le dépôt avance ou que la taille change ;
 *  - valeur = le RÉSULTAT de l'analyse, jamais les octets : soit `header` (taille, « complet ou non », et les seules clés utiles à l'estimateur : `general.architecture` et
 *    les clés scalaires `<arch>.*`, 128 au plus, chaînes ≤ 256 caractères), soit `unreadable` (un en-tête hostile donne « Not estimated », résultat déterministe) ;
 *  - un « Not checked » (réseau, 429, `Range` ignoré, annulation) n'arrive jamais ici : c'est l'appelant qui ne l'enregistre pas ;
 *  - LRU à 500 entrées : une nouvelle entrée n'est jamais refusée, la moins récemment utilisée sort ;
 *  - le fichier est écrit atomiquement (temporaire puis renommage) ; absent, illisible ou de forme inconnue = cache vide, sans exception ; une écriture impossible garde
 *    l'analyse en mémoire pour ce processus et laisse une ligne de journal. `get` ne fait aucune requête et ne touche pas au disque.
 *
 * Limite dite : une chaîne de plus de 256 caractères est tronquée dans le cache (seul le texte d'un message de verdict en dépend : l'estimateur ne lit que des
 * entiers et le nom d'architecture).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GgufMetadata, GgufValue } from "./gguf-fit.js";

export const HF_FIT_CACHE_MAX = 500;
const FORMAT_VERSION = 1;
const MAX_KEYS = 128;
const MAX_STRING = 256;
const MAX_ARRAY = 64;

export interface HfFitKey {
  repo: string;
  /** Commit épinglé (40 hexadécimaux). */
  sha: string;
  file: string;
  /** Taille du fichier dont l'en-tête est lu (le premier fragment d'un jeu). */
  size: number;
}

/** Une valeur de clé telle qu'elle est écrite : le JSON ne sait dire ni `bigint`, ni `NaN`, ni l'infini — des étiquettes les gardent EXACTES (le verdict n'en dépend pas du cache). */
export type CachedValue = number | boolean | string | CachedValue[] | { skipped: "array"; length: number } | { t: "bigint"; v: string } | { t: "num"; v: "NaN" | "Infinity" | "-Infinity" };

export type HfAnalysis = { kind: "header"; fileBytes: number; complete: boolean; kv: Record<string, CachedValue> } | { kind: "unreadable"; reason: string };

function encode(value: GgufValue): CachedValue | undefined {
  if (typeof value === "bigint") return { t: "bigint", v: value.toString() };
  if (typeof value === "number") return Number.isFinite(value) ? value : { t: "num", v: Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity" };
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return { skipped: "array", length: value.length };
    const out: CachedValue[] = [];
    for (const v of value) {
      const e = encode(v);
      if (e === undefined || (typeof e === "object" && !Array.isArray(e) && "skipped" in e)) return { skipped: "array", length: value.length };
      out.push(e);
    }
    return out;
  }
  return value.skipped === "array" ? { skipped: "array", length: value.length } : undefined;
}

function decode(value: CachedValue): GgufValue {
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value === "object") {
    if ("skipped" in value) return { skipped: "array", length: value.length };
    return value.t === "bigint" ? BigInt(value.v) : Number(value.v);
  }
  return value;
}

/** Du résultat d'une lecture d'en-tête au contenu du cache : seulement `general.architecture` et les clés scalaires `<arch>.*`, bornées. */
export function analysisFromMetadata(metadata: Pick<GgufMetadata, "kv" | "complete">, fileBytes: number): HfAnalysis {
  const arch = metadata.kv.get("general.architecture");
  const kv: Record<string, CachedValue> = {};
  let count = 0;
  for (const [key, value] of metadata.kv) {
    if (count >= MAX_KEYS) break;
    const wanted = key === "general.architecture" || (typeof arch === "string" && key.startsWith(`${arch}.`));
    if (!wanted) continue;
    const encoded = encode(value);
    if (encoded === undefined) continue;
    kv[key] = encoded;
    count++;
  }
  return { kind: "header", fileBytes, complete: metadata.complete, kv };
}

/** Du cache aux métadonnées que l'estimateur lit (`kv`) — la même forme qu'une lecture fraîche. */
export function metadataFromAnalysis(analysis: Extract<HfAnalysis, { kind: "header" }>): { kv: Map<string, GgufValue>; complete: boolean } {
  return { kv: new Map(Object.entries(analysis.kv).map(([k, v]) => [k, decode(v)])), complete: analysis.complete };
}

interface Stored {
  key: HfFitKey;
  used: number;
  analysis: HfAnalysis;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKey = (k: HfFitKey) => JSON.stringify([k.repo, k.sha, k.file, k.size]);

function validEntry(raw: unknown): Stored | null {
  if (!isObject(raw) || !isObject(raw.analysis)) return null;
  const { repo, sha, file, size, used, analysis } = raw as Record<string, unknown> & { analysis: Record<string, unknown> };
  if (typeof repo !== "string" || typeof sha !== "string" || typeof file !== "string" || !Number.isSafeInteger(size) || (size as number) <= 0) return null;
  if (!Number.isSafeInteger(used) || (used as number) < 0) return null;
  let parsed: HfAnalysis;
  if (analysis.kind === "unreadable" && typeof analysis.reason === "string") parsed = { kind: "unreadable", reason: analysis.reason };
  else if (analysis.kind === "header" && Number.isSafeInteger(analysis.fileBytes) && typeof analysis.complete === "boolean" && isObject(analysis.kv)) {
    parsed = { kind: "header", fileBytes: analysis.fileBytes as number, complete: analysis.complete, kv: analysis.kv as Record<string, CachedValue> };
  } else return null;
  return { key: { repo, sha, file, size: size as number }, used: used as number, analysis: parsed };
}

export class HfFitCache {
  private readonly entries = new Map<string, Stored>();
  private tick = 0;
  private readonly path: string;
  private readonly max: number;
  private readonly journal: (line: string) => void;
  private readonly rename: typeof renameSync;

  constructor(o: { path: string; max?: number; journal?: (line: string) => void; rename?: typeof renameSync }) {
    this.path = o.path;
    this.max = o.max ?? HF_FIT_CACHE_MAX;
    this.journal = o.journal ?? ((line) => console.warn(`[hf-fit-cache] ${line}`));
    this.rename = o.rename ?? renameSync;
    this.load();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Sans requête ni écriture : l'analyse de cette clé, ou `null`. La lecture compte comme un usage récent (en mémoire ; le disque suit à la prochaine écriture). */
  get(key: HfFitKey): HfAnalysis | null {
    const stored = this.entries.get(sameKey(key));
    if (!stored) return null;
    stored.used = ++this.tick;
    return stored.analysis;
  }

  /** « Déjà analysé ? » — ne change pas l'ordre d'usage (l'écran l'appelle pour afficher, pas pour s'en servir). */
  has(key: HfFitKey): boolean {
    return this.entries.has(sameKey(key));
  }

  /** Enregistre (ou remplace) l'analyse d'une clé. Jamais refusé : au-delà du plafond, la moins récemment utilisée sort. */
  set(key: HfFitKey, analysis: HfAnalysis): void {
    this.entries.set(sameKey(key), { key: { ...key }, used: ++this.tick, analysis });
    this.evict();
    this.persist();
  }

  /** Retire les entrées les moins récemment utilisées jusqu'au plafond. */
  private evict(): void {
    while (this.entries.size > this.max) {
      let oldest: [string, Stored] | null = null;
      for (const e of this.entries) if (oldest === null || e[1].used < oldest[1].used) oldest = e;
      if (oldest === null) break;
      this.entries.delete(oldest[0]);
    }
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.journal(`lecture de ${this.path} impossible : ${(e as Error).message.slice(0, 120)} — cache vide`);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.journal(`${this.path} n'est pas du JSON — cache vide`);
      return;
    }
    if (!isObject(json) || json.version !== FORMAT_VERSION || !Array.isArray(json.entries)) {
      this.journal(`${this.path} : forme ou version inconnue — cache vide`);
      return;
    }
    let skipped = 0;
    for (const raw of json.entries) {
      const entry = validEntry(raw);
      if (!entry) {
        skipped++;
        continue;
      }
      this.entries.set(sameKey(entry.key), entry);
      this.tick = Math.max(this.tick, entry.used);
    }
    if (skipped > 0) this.journal(`${skipped} entrée(s) abîmée(s) écartée(s) de ${this.path}`);
    this.evict();
  }

  /** Écriture atomique : un temporaire du même dossier, puis un renommage. Une panne laisse l'ancien fichier intact, retire le temporaire et le dit. */
  private persist(): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const body = { version: FORMAT_VERSION, entries: [...this.entries.values()].map((s) => ({ ...s.key, used: s.used, analysis: s.analysis })) };
      writeFileSync(tmp, JSON.stringify(body));
      this.rename(tmp, this.path);
    } catch (e) {
      this.journal(`écriture de ${this.path} impossible : ${(e as Error).message.slice(0, 120)} — l'analyse reste en mémoire pour ce processus`);
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* le temporaire n'existait pas */
      }
    }
  }
}
