// Passerelle compatible Hermes (essai) : la page Mémoire de Herald lit deux « fichiers » (MEMORY.md : ce que l'agent retient ; USER.md : ce qu'il sait
// de l'utilisateur), découpés en entrées. Jarod n'a pas ces fichiers : sa mémoire est une table (`MemoryService`) et son profil un USER.md à sections.
// Ce module présente l'un et l'autre sous la forme que la page attend, et traduit une liste d'entrées réécrite en changements MINIMAUX (une entrée
// modifiée est mise à jour, pas supprimée puis recréée : identifiants, dates et types sont conservés).
//   MEMORY.md ↔ les souvenirs (`core.memory`), dans l'ordre de création (stable : modifier une entrée ne la déplace pas)
//   USER.md   ↔ les lignes du profil (`core.userProfile`), section après section
import { statSync } from "node:fs";

export type MemoryFileName = "MEMORY.md" | "USER.md";
export const MEMORY_FILE_NAMES: readonly MemoryFileName[] = ["MEMORY.md", "USER.md"];
/** Entrées au plus par écriture, et taille d'une entrée : des bornes de bon sens contre une page qui boucle. */
export const MAX_ENTRIES = 500;
export const MAX_ENTRY_CHARS = 8000;
/** La section où va une ligne ajoutée au profil. */
export const DEFAULT_PROFILE_SECTION = "Préférences";

export interface MemoryLike {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryServiceLike {
  list(): readonly MemoryLike[];
  add(content: string): unknown;
  update(id: string, content: string): void;
  delete(id: string): void;
}

export interface ProfileLike {
  read(): string;
  exists(): boolean;
  path(): string;
  setSection(name: string, lines: string[]): void;
}

export interface MemoryFileView {
  exists: boolean;
  /** Époque en millisecondes ; 0 si inconnue. */
  modified_at: number;
  texts: string[];
  /** La date de création de chaque entrée (ms), quand on la connaît : la page s'en sert à la place de la date du fichier. */
  dates?: number[];
}

export interface Item {
  id: string;
  text: string;
}

export interface Diff {
  updates: { id: string; text: string }[];
  deletes: string[];
  adds: string[];
}

/**
 * Passe de la liste actuelle à la liste voulue par le plus petit nombre de changements. Une entrée inchangée est gardée ; parmi le reste,
 * les anciennes et les nouvelles sont appariées dans l'ordre (c'est une mise à jour), puis l'excédent est supprimé ou ajouté.
 */
export function diffEntries(current: readonly Item[], wanted: readonly string[]): Diff {
  const pool = current.map((c) => ({ ...c, used: false }));
  const fresh: string[] = [];
  for (const raw of wanted) {
    const text = raw.trim();
    if (!text) continue;
    const hit = pool.find((p) => !p.used && p.text === text);
    if (hit) hit.used = true;
    else fresh.push(text);
  }
  const stale = pool.filter((p) => !p.used);
  const paired = Math.min(stale.length, fresh.length);
  return {
    updates: stale.slice(0, paired).map((s, i) => ({ id: s.id, text: fresh[i]! })),
    deletes: stale.slice(paired).map((s) => s.id),
    adds: fresh.slice(paired),
  };
}

export type Sections = Map<string, string[]>;

/** Le USER.md de Jarod (`## Section` puis `- ligne`) → sections. Le titre `# …` et les lignes hors section sont ignorés, comme le fait le service. */
export function parseProfile(text: string): Sections {
  const map: Sections = new Map();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      current = h[1]!;
      if (!map.has(current)) map.set(current, []);
      continue;
    }
    const line = raw.trim();
    if (current && line) map.get(current)!.push(line.replace(/^[-*]\s*/, ""));
  }
  return map;
}

const profileItems = (sections: Sections): (Item & { section: string })[] => {
  const out: (Item & { section: string })[] = [];
  for (const [section, lines] of sections) lines.forEach((text, i) => { out.push({ id: `${section}\u0000${i}`, section, text }); });
  return out;
};

const mtime = (path: string): number => {
  try {
    return Math.round(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
};

const ordered = (list: readonly MemoryLike[]) => [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

/** Les deux « fichiers » tels que la page les lit. */
export function memoryFiles(memory: MemoryServiceLike, profile: ProfileLike): Record<MemoryFileName, MemoryFileView> {
  const entries = ordered(memory.list());
  const lines = profileItems(parseProfile(profile.read()));
  return {
    "MEMORY.md": {
      exists: entries.length > 0,
      modified_at: entries.reduce((m, e) => Math.max(m, e.updatedAt), 0),
      texts: entries.map((e) => e.content),
      dates: entries.map((e) => e.createdAt),
    },
    "USER.md": { exists: profile.exists(), modified_at: profile.exists() ? mtime(profile.path()) : 0, texts: lines.map((l) => l.text) },
  };
}

/** Vérifie le corps d'une écriture : une liste de textes, bornée. Lève avec un message destiné à l'utilisateur. */
export function checkTexts(body: unknown): string[] {
  const texts = (body as { texts?: unknown } | null)?.texts;
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) throw new Error("texts doit être une liste de textes");
  if (texts.length > MAX_ENTRIES) throw new Error(`Trop d'entrées (${texts.length}, au plus ${MAX_ENTRIES})`);
  for (const t of texts as string[]) if (t.length > MAX_ENTRY_CHARS) throw new Error(`Une entrée est trop longue (${t.length} caractères, au plus ${MAX_ENTRY_CHARS})`);
  return texts as string[];
}

/** Remplace la liste d'un « fichier » par `texts`, en changements minimaux. */
export function writeMemoryFile(file: MemoryFileName, texts: readonly string[], memory: MemoryServiceLike, profile: ProfileLike): void {
  if (file === "MEMORY.md") {
    const diff = diffEntries(ordered(memory.list()).map((e) => ({ id: e.id, text: e.content })), texts);
    for (const u of diff.updates) memory.update(u.id, u.text);
    for (const id of diff.deletes) memory.delete(id);
    for (const t of diff.adds) memory.add(t);
    return;
  }
  const sections = parseProfile(profile.read());
  const items = profileItems(sections);
  const diff = diffEntries(items, texts);
  const touched = new Set<string>();
  const byId = new Map(items.map((i) => [i.id, i]));
  // Les changements d'abord par position dans la section (les identifiants portent l'indice d'origine), puis on réécrit les sections touchées.
  const replaced = new Map<string, string>();
  const removed = new Set<string>();
  for (const u of diff.updates) {
    replaced.set(u.id, u.text);
    touched.add(byId.get(u.id)!.section);
  }
  for (const id of diff.deletes) {
    removed.add(id);
    touched.add(byId.get(id)!.section);
  }
  const next = new Map<string, string[]>();
  for (const [section, lines] of sections) {
    if (!touched.has(section)) continue;
    next.set(section, lines.flatMap((text, i) => {
      const id = `${section}\u0000${i}`;
      return removed.has(id) ? [] : [replaced.get(id) ?? text];
    }));
  }
  if (diff.adds.length) {
    const base = next.get(DEFAULT_PROFILE_SECTION) ?? [...(sections.get(DEFAULT_PROFILE_SECTION) ?? [])];
    next.set(DEFAULT_PROFILE_SECTION, [...base, ...diff.adds]);
  }
  for (const [section, lines] of next) profile.setSection(section, lines);
}
