/**
 * Lecture de la fiche d'un dépôt Hugging Face et regroupement des fragments (SPECS-P5-MODELS.md § 3.4, § 3.5, § 3.9 (e) et (g)). Fonctions PURES : le transport est dans
 * `HuggingFaceService.repoInfo`.
 *
 * Deux règles de la spec :
 *  - le SHA-256 attendu vient de l'API (`siblings[].lfs.sha256` avec `?blobs=true`, ou `lfs.oid` d'une entrée `tree`), jamais de l'`ETag` du CDN ;
 *  - le résumé `gguf` de la fiche (`context_length` 8192 affiché contre 32768 dans le fichier) n'est JAMAIS lu : il ne peut pas devenir un verdict.
 */
import { fileNameProblem } from "./hf-names.js";
import { HfApiError } from "./hf-fetch.js";
import { HfDownloadError } from "./hf-transfer.js";

export const HF_MAX_ENTRIES = 500;

/** Un fichier du dépôt avec ce que l'API publie : taille et, quand il existe, SHA-256 (`null` = non publié, seule la taille sera vérifiée). */
export interface HfRepoFile {
  name: string;
  size: number;
  sha256: string | null;
}

/** Un « modèle » pour l'utilisateur : un fichier, ou TOUS les fragments d'un modèle découpé (jamais N entrées). */
export interface HfEntry {
  /** Identifiant stable et unique dans le dépôt : le nom du fichier, ou `<préfixe>-of-<total sur 5 chiffres>` pour un jeu de fragments. */
  key: string;
  files: HfRepoFile[];
  /** Somme des tailles publiées des fichiers PRÉSENTS. */
  totalBytes: number;
  /** Nombre de fragments annoncé par le nom (`-of-0000N`), `null` pour un fichier simple. */
  shardCount: number | null;
  /** Faux quand un fragment manque : l'entrée est listée mais NON téléchargeable. */
  complete: boolean;
  /** Indices (à partir de 1) des fragments absents du dépôt. */
  missing: number[];
}

const SHARD = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const PINNED = /^[0-9a-f]{40}$/;

const byKey = (a: HfEntry, b: HfEntry) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Regroupe les fragments `…-00001-of-0000N.gguf` en UNE entrée. Deux jeux de même préfixe mais de totaux différents ne sont jamais fusionnés ; un indice 0 ou
 * supérieur au total ne désigne pas un fragment (fichier simple). Le plafond (`maxEntries`) compte des ENTRÉES, pas des fichiers. Ordre déterministe.
 */
export function groupGgufFiles(files: readonly HfRepoFile[], maxEntries = HF_MAX_ENTRIES): { entries: HfEntry[]; truncated: boolean } {
  const sets = new Map<string, { prefix: string; total: number; shards: Map<number, HfRepoFile> }>();
  const entries: HfEntry[] = [];
  for (const file of files) {
    const m = SHARD.exec(file.name);
    const index = m ? Number(m[2]) : 0;
    const total = m ? Number(m[3]) : 0;
    if (!m || index < 1 || index > total) {
      entries.push({ key: file.name, files: [file], totalBytes: file.size, shardCount: null, complete: true, missing: [] });
      continue;
    }
    const key = `${m[1]}-of-${m[3]}`;
    const set = sets.get(key) ?? { prefix: m[1]!, total, shards: new Map() };
    set.shards.set(index, file);
    sets.set(key, set);
  }
  for (const [key, set] of sets) {
    const present = [...set.shards.entries()].sort((a, b) => a[0] - b[0]);
    const missing: number[] = [];
    for (let i = 1; i <= set.total; i++) if (!set.shards.has(i)) missing.push(i);
    entries.push({
      key,
      files: present.map(([, f]) => f),
      totalBytes: present.reduce((n, [, f]) => n + f.size, 0),
      shardCount: set.total,
      complete: missing.length === 0,
      missing,
    });
  }
  entries.sort(byKey);
  return { entries: entries.slice(0, maxEntries), truncated: entries.length > maxEntries };
}

/** Les fichiers à télécharger pour une entrée : refuse une entrée incomplète (un fragment manque) AVANT toute requête. */
export function entryDownloadFiles(entry: HfEntry): HfRepoFile[] {
  if (!entry.complete) {
    throw new HfDownloadError("INCOMPLETE_SET", `${entry.key} : fragment(s) manquant(s) dans le dépôt (${entry.missing.join(", ")}), jeu non téléchargeable`);
  }
  return entry.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 }));
}

/** Un fichier `.gguf` vu par l'API, avant validation : le nom a pu être refusé (`problem`), la taille peut manquer (`size: null`). */
export interface HfCandidate {
  name: string;
  size: number | null;
  sha256: string | null;
  problem: string | null;
}

const positive = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);
const sha = (v: unknown): string | null => (typeof v === "string" && HEX64.test(v) ? v.toLowerCase() : null);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function candidate(name: string, size: number | null, sha256: string | null): HfCandidate {
  const problem = fileNameProblem(name);
  return { name, size, sha256, problem: problem ? problem.reason : null };
}

/** Une ligne de `siblings` (réponse `?blobs=true`) : seulement les `.gguf` ; taille de `size` ou `lfs.size`, SHA-256 de `lfs.sha256` (absent pour un fichier non-LFS). */
export function candidateFromSibling(raw: unknown): HfCandidate | null {
  if (!isObject(raw) || typeof raw.rfilename !== "string" || !raw.rfilename.toLowerCase().endsWith(".gguf")) return null;
  const lfs = isObject(raw.lfs) ? raw.lfs : {};
  return candidate(raw.rfilename, positive(raw.size) ?? positive(lfs.size), sha(lfs.sha256));
}

/** Une entrée de `tree` : seulement les fichiers `.gguf` ; taille de `lfs.size` ou `size`, SHA-256 de `lfs.oid` (l'`oid` de premier niveau est un identifiant git, PAS un SHA-256). */
export function candidateFromTreeEntry(raw: unknown): HfCandidate | null {
  if (!isObject(raw) || raw.type !== "file" || typeof raw.path !== "string" || !raw.path.toLowerCase().endsWith(".gguf")) return null;
  const lfs = isObject(raw.lfs) ? raw.lfs : {};
  return candidate(raw.path, positive(lfs.size) ?? positive(raw.size), sha(lfs.oid));
}

export interface Fiche {
  sha: string;
  gated: false | string;
  license: string | null;
  siblings: unknown[];
}

/** La fiche d'un dépôt. `gated` : `false` ou une chaîne (« manual » observé) ; tout ce qui n'est pas faux est « gated ». Le résumé `gguf` de la fiche n'est PAS lu. */
export function parseFiche(json: unknown): Fiche {
  const bad = (why: string) => new HfApiError("BAD_RESPONSE", why);
  if (!isObject(json)) throw bad("la fiche n'est pas un objet JSON");
  if (typeof json.sha !== "string" || !PINNED.test(json.sha)) throw bad("la fiche n'a pas de révision lisible (40 hexadécimaux)");
  if (!Array.isArray(json.siblings)) throw bad("la fiche n'a pas de liste de fichiers");
  const gated = json.gated === false || json.gated === undefined || json.gated === null ? false : typeof json.gated === "string" ? json.gated : json.gated === true ? "true" : "unknown";
  const card = isObject(json.cardData) ? json.cardData : {};
  const tag = Array.isArray(json.tags) ? json.tags.find((t): t is string => typeof t === "string" && t.startsWith("license:")) : undefined;
  const license = typeof card.license === "string" && card.license ? card.license : tag ? tag.slice("license:".length) : null;
  return { sha: json.sha, gated, license, siblings: json.siblings };
}

/** L'URL de la page suivante d'un en-tête `Link: <url>; rel="next"` (forme observée, § 1.4), résolue contre `base` ; `null` quand il n'y en a pas. */
export function linkNext(header: string | null, base: URL): URL | null {
  if (!header) return null;
  for (const m of header.matchAll(/<([^>]*)>([^,<]*)/g)) {
    if (/;\s*rel\s*=\s*"?next"?/i.test(m[2] ?? "")) {
      try {
        return new URL(m[1]!, base);
      } catch {
        return null;
      }
    }
  }
  return null;
}
