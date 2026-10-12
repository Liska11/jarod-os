/**
 * T15 (SPECS-P5-MODELS.md § 10) — garde du dépôt : `cleanup()` de `@jarod/kernel/testing` est ASYNCHRONE (il arrête les noyaux puis supprime les dossiers temporaires).
 * Appelé sans `await` il flotte : le dossier n'est pas supprimé quand le fichier de test se termine (≈ 14 dossiers `jarod-test-*` laissés par passe) et une erreur de
 * suppression (`EPERM`) devient une « Unhandled Rejection » qui fait échouer la passe alors que tous les tests passent (T14). Tout fichier qui l'importe l'attend.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Les fichiers (suivis ou à suivre) qui importent le helper de test du noyau. */
function importers(): string[] {
  try {
    return execFileSync("git", ["grep", "-l", "--untracked", "-E", "from \"@jarod/kernel/testing\"", "--", "*.ts", "*.tsx"], { cwd: repoRoot, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((f) => f && f !== "tests/repo/cleanup-awaited.test.ts");
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

/** Les lignes où `cleanup()` est appelé comme une instruction nue (ou avec `void`) : ni `await`, ni `return`, ni passé comme hook. */
export function floatingCleanups(source: string): number[] {
  const bad: number[] = [];
  source.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(void\s+)?cleanup\(\)\s*;?\s*(\/\/.*)?$/.test(line)) bad.push(i + 1);
  });
  return bad;
}

describe("T15 — cleanup() du noyau de test est toujours attendu", () => {
  it("le détecteur voit l'appel flottant et laisse passer await / return / hook", () => {
    expect(floatingCleanups("afterEach(() => {\n  cleanup();\n});")).toEqual([2]);
    expect(floatingCleanups("  void cleanup();")).toEqual([1]);
    expect(floatingCleanups("  await cleanup();\n  return cleanup();\nafterEach(cleanup);\nafterEach(() => cleanup());")).toEqual([]);
  });

  it("aucun fichier de test qui importe @jarod/kernel/testing n'appelle cleanup() sans l'attendre", () => {
    const files = importers();
    expect(files.length).toBeGreaterThan(20); // le garde voit bien les fichiers (sinon il passerait à vide)
    const offenders = files.flatMap((f) => floatingCleanups(readFileSync(resolve(repoRoot, f), "utf8")).map((n) => `${f}:${n}`));
    expect(offenders).toEqual([]);
  });
});
