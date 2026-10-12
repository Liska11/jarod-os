// Outils système : `system_find_files`, la recherche de fichiers (lecture seule). Portée de `find_files` de Herald OS (plugins/herald-os-bridge,
// MIT, licenses/HERALD-OS.md) sans ripgrep ni Python : un parcours borné (délai, nombre d'entrées, aucun lien suivi) et des prédicats purs.
//
// Écarts voulus par rapport à Herald :
//  - `text` ne cherche que dans le NOM du fichier. Lire le contenu des fichiers de la personne pour répondre à une question de recherche est
//    une lecture bien plus large que celle que l'outil annonce ; la description le dit, au lieu de promettre la recherche de contenu.
//  - les emplacements protégés (clés, identifiants, dossiers du système) ne sont ni parcourus ni cités, et un `scope` protégé est refusé avant toute lecture.
//  - `since`/`until` comparent la date de CRÉATION (celle de l'Explorateur), comme « fichiers créés hier ».
import { type Dirent, statSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandHome, protectedRoot, protectedRoots, realPathOrSelf } from "./disk.js";

export const KINDS = ["any", "image", "screenshot", "document", "pdf", "video", "audio", "folder", "code", "archive"] as const;
export type Kind = (typeof KINDS)[number];
export const WHENS = ["today", "yesterday", "this_week", "last_7_days", "this_month"] as const;
export type When = (typeof WHENS)[number];

const KIND_EXTENSIONS: Record<string, readonly string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "svg", "tif", "tiff", "avif"],
  screenshot: ["png", "jpg", "jpeg", "webp"],
  document: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "xls", "xlsx", "ods", "ppt", "pptx", "odp", "epub"],
  pdf: ["pdf"],
  video: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "mpg", "mpeg", "wmv"],
  audio: ["mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma"],
  code: ["py", "js", "ts", "tsx", "jsx", "go", "rs", "c", "h", "cpp", "hpp", "java", "rb", "sh", "swift", "kt", "php", "html", "css", "json", "yaml", "yml", "toml", "sql", "lua"],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "deb", "rpm", "appimage"],
};
const SCREENSHOT_NAME = /screenshot|screen shot|screencapture|captura|capture d.[ée]cran|snip/i;
/** Dossiers de bruit : jamais parcourus (comme dans Herald). */
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "$recycle.bin", "system volume information", "__pycache__", ".venv", "venv", ".cache"]);

export const MAX_ENTRIES_SCANNED = 500_000;
export const DEFAULT_DEADLINE_MS = 25_000;

export interface Search {
  text?: string;
  name?: string;
  kind: Kind;
  /** Bornes de création, en millisecondes (inclusive, exclusive) ; `null` = pas de borne. */
  since: number | null;
  until: number | null;
  extensions: string[];
  limit: number;
}

export interface Found {
  path: string;
  size: number | null;
  modified: string;
  created: string;
  kind: "file" | "folder";
}

export interface FindResult {
  files: Found[];
  /** Le parcours s'est arrêté (délai, nombre d'entrées ou interruption) avant d'avoir tout vu. */
  partial: boolean;
  scanned: number;
  roots: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** « 2026-10-11 » (jour local) ou une date ISO 8601 → millisecondes ; `endOfDay` ajoute un jour à une date seule (borne exclusive). Lève si invalide. */
export function parseDate(value: string, endOfDay: boolean): number {
  const v = value.trim();
  const bad = () => new Error(`date invalide « ${value} » (utiliser AAAA-MM-JJ ou ISO 8601)`);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (dayKey(d) !== v) throw bad(); // 2026-02-31 n'est pas un jour
    if (endOfDay) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) throw bad();
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) throw bad();
  return t;
}

/** Une fenêtre relative → les jours `since` (inclus) et `until` (jour inclus), en jours locaux AAAA-MM-JJ. Semaine : du lundi à aujourd'hui. */
export function resolveWhen(when: When, today: Date = new Date()): { since: string; until: string } {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const shifted = (days: number) => {
    const d = new Date(t);
    d.setDate(d.getDate() + days);
    return dayKey(d);
  };
  const now = dayKey(t);
  if (when === "today") return { since: now, until: now };
  if (when === "yesterday") return { since: shifted(-1), until: shifted(-1) };
  if (when === "this_week") return { since: shifted(-((t.getDay() + 6) % 7)), until: now };
  if (when === "last_7_days") return { since: shifted(-7), until: now };
  return { since: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-01`, until: now };
}

/** Les extensions que la recherche accepte (minuscules, sans point) ; vide = toutes. Un type ET des extensions : l'intersection. */
export function searchExtensions(search: Pick<Search, "kind" | "extensions">): Set<string> {
  const given = new Set(search.extensions.map((e) => e.replace(/^\.+/, "").toLowerCase()).filter(Boolean));
  const kind = KIND_EXTENSIONS[search.kind];
  if (!kind) return given;
  return given.size ? new Set([...given].filter((e) => kind.includes(e))) : new Set(kind);
}

/**
 * Le nom (et le type d'entrée) satisfont-ils la recherche ? Pur. Quand un type ET des extensions n'ont rien en commun (ex. `pdf` + `png`),
 * rien ne correspond : l'ensemble vide n'est pas « tout ».
 */
export function matchesName(name: string, isDir: boolean, search: Pick<Search, "kind" | "extensions" | "name" | "text">): boolean {
  const lower = name.toLowerCase();
  if (search.kind === "folder") {
    if (!isDir) return false;
  } else if (search.kind !== "any" && isDir) return false;
  if (search.name && !lower.includes(search.name.toLowerCase())) return false;
  if (search.text && !lower.includes(search.text.toLowerCase())) return false;
  const wantsExtension = search.extensions.some((e) => e.replace(/^\.+/, "")) || KIND_EXTENSIONS[search.kind] !== undefined;
  if (wantsExtension) {
    const allowed = searchExtensions(search);
    const dot = lower.lastIndexOf(".");
    const ext = dot > 0 ? lower.slice(dot + 1) : "";
    if (isDir || !allowed.has(ext)) return false;
  }
  if (search.kind === "screenshot" && !SCREENSHOT_NAME.test(name)) return false;
  return true;
}

export function matchesTime(createdMs: number, search: Pick<Search, "since" | "until">): boolean {
  if (search.since !== null && createdMs < search.since) return false;
  if (search.until !== null && createdMs >= search.until) return false;
  return true;
}

/** Les dossiers de la personne parcourus quand aucun `scope` n'est donné (jamais tout AppData) ; ses dossiers OneDrive en plus. */
export function defaultRoots(env: NodeJS.ProcessEnv, home: string, isDirectory: (p: string) => boolean): { roots: string[]; skipAppData: boolean } {
  const bases = [home, ...["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].map((v) => env[v]).filter((v): v is string => !!v)];
  const roots: string[] = [];
  for (const base of bases) {
    for (const folder of ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"]) {
      const candidate = join(base, folder);
      if (isDirectory(candidate) && !roots.some((r) => r.toLowerCase() === candidate.toLowerCase())) roots.push(candidate);
    }
  }
  return roots.length ? { roots, skipAppData: true } : { roots: [home], skipAppData: true };
}

export interface FindDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Les racines à parcourir ; sinon `scope` si donné, sinon les dossiers de la personne. */
  scope?: string;
  deadlineMs?: number;
  maxEntries?: number;
  signal?: AbortSignal | undefined;
  /** Pour les tests : le dossier existe-t-il (choix des dossiers par défaut). */
  isDirectory?: (p: string) => boolean;
}

/** Le dossier (réel) donné en `scope` : absolu, jamais protégé (par le nom, puis par le chemin réel). Lève sinon. */
export function checkScope(raw: string, env: NodeJS.ProcessEnv, home: string): string {
  const path = expandHome(raw.trim(), home);
  if (!isAbsolute(path)) throw new Error(`Chemin non absolu : ${raw}. Donner un chemin complet (ex. C:\\Users\\moi\\Downloads) ou ~.`);
  const roots = protectedRoots(env, home);
  const hit = protectedRoot(path, roots) ?? protectedRoot(realPathOrSelf(path), roots);
  if (hit) throw new Error(`${path} est dans l'emplacement protégé ${hit} : cet outil n'y cherche rien.`);
  return resolve(path);
}

export async function findFiles(search: Search, deps: FindDeps = {}): Promise<FindResult> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const isDir = deps.isDirectory ?? isDirectorySync;
  let roots: string[];
  let skipAppData = false;
  if (deps.scope) roots = [checkScope(deps.scope, env, home)];
  else ({ roots, skipAppData } = defaultRoots(env, home, isDir));
  const protectedList = protectedRoots(env, home);
  const deadline = Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxEntries = deps.maxEntries ?? MAX_ENTRIES_SCANNED;
  const wanted = Math.max(1, search.limit) * 20;
  const found = new Map<string, Found>();
  let scanned = 0;
  let partial = false;
  const stop = (): boolean => {
    if (deps.signal?.aborted) throw new Error("Interrompu");
    if (Date.now() > deadline || scanned >= maxEntries) {
      partial = true;
      return true;
    }
    return false;
  };

  const stack = [...roots];
  while (stack.length && !stop() && found.size < wanted) {
    const dir = stack.pop()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    try {
      for await (const entry of handle as AsyncIterable<Dirent>) {
        if (stop()) break;
        scanned++;
        if (entry.isSymbolicLink()) continue; // liens et jonctions : jamais suivis, jamais cités
        const path = join(dir, entry.name);
        const directory = entry.isDirectory();
        if (directory) {
          const lowered = entry.name.toLowerCase();
          if (SKIP_DIRS.has(lowered) || (skipAppData && lowered === "appdata") || protectedRoot(path, protectedList)) continue;
          stack.push(path);
        } else if (protectedRoot(path, protectedList)) continue;
        if (!matchesName(entry.name, directory, search)) continue;
        try {
          const st = await lstat(path);
          if (!matchesTime(st.birthtimeMs, search)) continue;
          found.set(path, {
            path,
            size: directory ? null : st.size,
            modified: new Date(st.mtimeMs).toISOString(),
            created: new Date(st.birthtimeMs).toISOString(),
            kind: directory ? "folder" : "file",
          });
        } catch {
          continue;
        }
        if (found.size >= wanted) break;
      }
    } catch (e) {
      if (deps.signal?.aborted) throw e;
    }
  }
  if (stack.length && found.size >= wanted) partial = true;
  const files = [...found.values()].sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0)).slice(0, search.limit);
  return { files, partial, scanned, roots };
}

function isDirectorySync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
