/**
 * Garde de commit : refuse de committer un fichier VIDÉ (ou presque) par accident. Incident du 2026-10-01 : un script d'édition a ouvert
 * `tests/bench/voice-contention.ts` en écriture avant de le lire, le fichier est devenu vide et a été committé tel quel (299 lignes
 * supprimées) ; seul un lancement qui ne mesurait rien l'a révélé. Mêmes règles dans le crochet `pre-commit` (scripts/git-hooks) et dans le
 * test du dépôt.
 *
 * Règles (fichiers ajoutés ou modifiés ; une suppression est toujours permise) :
 *   1. taille 0 → refusé (sauf `.gitkeep`, `.keep`, `__init__.py`, `py.typed`, qui sont vides par nature) ;
 *   2. un fichier d'au moins 2 Kio qui perd 95 % ou plus de sa taille → refusé (vidé « presque » : une seule ligne restante).
 * Dérogation, pour UN commit voulu : `JAROD_ALLOW_EMPTY=1 git commit …` (la garde le dit, rien n'est silencieux).
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface StagedEntry {
  path: string;
  /** Taille dans l'index (octets). */
  newSize: number;
  /** Taille dans HEAD, ou null si le fichier est nouveau. */
  oldSize: number | null;
}

/** Fichiers vides par nature. */
export const EMPTY_BY_NATURE: ReadonlySet<string> = new Set([".gitkeep", ".keep", "__init__.py", "py.typed"]);
export const SHRINK_MIN_OLD_BYTES = 2048;
export const SHRINK_RATIO = 0.05;

export function stagedProblems(entries: readonly StagedEntry[]): string[] {
  const problems: string[] = [];
  for (const e of entries) {
    if (e.newSize === 0 && !EMPTY_BY_NATURE.has(basename(e.path))) {
      problems.push(e.oldSize ? `${e.path} : fichier VIDÉ (${e.oldSize} octets dans HEAD, 0 dans l'index)` : `${e.path} : fichier vide ajouté`);
    } else if (e.oldSize !== null && e.oldSize >= SHRINK_MIN_OLD_BYTES && e.newSize > 0 && e.newSize <= e.oldSize * SHRINK_RATIO) {
      problems.push(`${e.path} : fichier presque vidé (${e.oldSize} → ${e.newSize} octets, ${Math.round((1 - e.newSize / e.oldSize) * 100)} % perdus)`);
    }
  }
  return problems;
}

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });

/** Lit l'index de `cwd` : chemins ajoutés ou modifiés avec leur taille dans l'index et dans HEAD. */
export function readStaged(cwd: string): StagedEntry[] {
  const names = git(cwd, ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z", "--no-renames"]).split("\0").filter(Boolean);
  if (names.length === 0) return [];
  const sizes = (prefix: string): (number | null)[] =>
    git(cwd, ["cat-file", "--batch-check"], names.map((n) => `${prefix}${n}`).join("\n") + "\n")
      .split("\n")
      .filter(Boolean)
      .map((l) => (l.endsWith(" missing") ? null : Number(l.split(" ")[2])));
  const now = sizes(":");
  const before = sizes("HEAD:");
  return names.map((path, i) => ({ path, newSize: now[i] ?? 0, oldSize: before[i] ?? null }));
}
