/**
 * T16 (SPECS-P5-MODELS.md § 10) — garde du dépôt, sœur de `cleanup-awaited.test.ts` : un fichier qui crée un dossier temporaire avec `mkdtemp` / `mkdtempSync` doit
 * aussi le supprimer (`rmSync`, `rm`, `rmdirSync`) ou passer par `tempDir()` + `cleanup()` du noyau de test. Sans cela chaque passe de la suite laisse ses dossiers dans
 * `%TEMP%` : `jarod-port-`, `jarod-spill-`, `jarod-gate-p1-`, `jarod-gate-p1-cwd-`, `jarod-gate-p4-cwd-`, `jarod-gate-p4-budget-` s'y accumulaient sans fin
 * (T9 ne balaie que `jarod-test-*`). Le garde est au niveau du FICHIER : il ne prouve pas que chaque dossier est supprimé, il empêche le cas où RIEN ne l'est.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Les fichiers (suivis ou à suivre) qui appellent `mkdtemp` / `mkdtempSync`. */
function creators(): string[] {
  try {
    return execFileSync("git", ["grep", "-l", "--untracked", "-E", "mkdtemp(Sync)?\\(", "--", "*.ts", "*.tsx"], { cwd: repoRoot, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((f) => f && f !== "tests/repo/temp-dirs-cleaned.test.ts");
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

/** Le code sans ses commentaires : un mot cité en commentaire ne vaut pas un appel. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
}

/** Vrai si le fichier crée un dossier temporaire et ne contient AUCUN moyen de le supprimer. */
export function leaksTempDirs(source: string): boolean {
  const c = code(source);
  const creates = /\bmkdtemp(Sync)?\(/.test(c);
  const removes = /\b(rmSync|rmdirSync)\(|\brm\(|\bcleanup\b/.test(c);
  return creates && !removes;
}

describe("T16 — tout fichier qui crée un dossier temporaire sait le supprimer", () => {
  it("le détecteur voit un fichier sans suppression et laisse passer rmSync / rm / cleanup, ignore les commentaires", () => {
    expect(leaksTempDirs('const d = mkdtempSync(join(tmpdir(), "x-"));')).toBe(true);
    expect(leaksTempDirs('const d = await mkdtemp(join(tmpdir(), "x-"));')).toBe(true);
    expect(leaksTempDirs('const d = mkdtempSync(p);\n// rmSync(d) viendra plus tard\n/* cleanup() */')).toBe(true);
    expect(leaksTempDirs('const d = mkdtempSync(p);\nafterAll(() => rmSync(d, { recursive: true, force: true }));')).toBe(false);
    expect(leaksTempDirs('const d = mkdtempSync(p);\nawait rm(d, { recursive: true });')).toBe(false);
    expect(leaksTempDirs('const d = mkdtempSync(p);\nafterEach(cleanup);')).toBe(false);
    expect(leaksTempDirs("const d = tempDir();")).toBe(false);
  });

  it("aucun fichier du dépôt n'appelle mkdtemp sans pouvoir supprimer", () => {
    const files = creators();
    expect(files.length).toBeGreaterThan(20); // le garde voit bien les fichiers (sinon il passerait à vide)
    const offenders = files.filter((f) => leaksTempDirs(readFileSync(resolve(repoRoot, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
