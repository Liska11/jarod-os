/**
 * Renommage Herald → Jarod (docs/RENAME-PLAN-JAROD-OS.md, phase 0 « filet ») — garde du dépôt ENTIER (la racine au-dessus de jarod-core).
 *
 * (1) Les attributions dues à Herald OS (MIT, © 2026 Luke The Dev) ne disparaissent jamais : le renommage ne réécrit pas une licence.
 * (2) Cliquet : un fichier ne peut pas compter PLUS de lignes « herald » que ne l'autorise `rename-baseline.json`, et un fichier absent de la
 *     liste n'en a pas le droit. Chaque phase fait baisser la liste ; ce qui reste à la fin, ce sont les exceptions voulues (attributions,
 *     historique daté, amont, partitions `persist:herald-*` gardées par décision du 2026-10-19).
 *     Régénérer après une phase : `node scripts/rename-inventory.mjs --files` (les comptes ne doivent que baisser).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const baseline = JSON.parse(readFileSync(resolve(here, "rename-baseline.json"), "utf8")) as Record<string, number>;

/** Lignes contenant « herald » par fichier (suivis et à suivre, hors binaires), hors l'inventaire et cette garde. */
function heraldByFile(): Record<string, number> {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["grep", "-c", "-I", "-i", "--untracked", "-e", "herald", "--", ".", ":(exclude)scripts/rename-inventory.mjs", ":(exclude)scripts/rename-baseline.mjs", ":(exclude)scripts/rename-apply.mjs", ":(exclude)scripts/rename-history.json", ":(exclude)jarod-core/tests/repo/rename-baseline.json", ":(exclude)jarod-core/tests/repo/rename-guard.test.ts"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 << 20 },
    );
  } catch (e) {
    if ((e as { status?: number }).status === 1) return {};
    throw e;
  }
  const map: Record<string, number> = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.lastIndexOf(":");
    if (i > 0) map[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return map;
}

const ATTRIBUTIONS: Array<[string, string[]]> = [
  ["LICENSE", ["Luke The Dev", "MIT"]],
  ["NOTICE", ["Luke The Dev", "MIT", "Herald"]],
  ["jarod-core/licenses/HERALD-OS.md", ["Luke The Dev", "MIT", "Herald"]],
];

describe("renommage Jarod-OS : garde du dépôt", () => {
  it.each(ATTRIBUTIONS)("l'attribution de %s est intacte", (file, needles) => {
    const text = readFileSync(resolve(repoRoot, file), "utf8");
    for (const n of needles) expect(text, `${file} doit contenir « ${n} »`).toContain(n);
  });

  it("le champ copyright du shell dit encore d'où vient le code", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "apps/desktop/package.json"), "utf8")) as { copyright?: string };
    expect(pkg.copyright).toMatch(/Herald OS.*Luke The Dev.*MIT/);
  });

  it("aucun « herald » nouveau : chaque fichier reste sous sa limite, aucun fichier hors liste", () => {
    const over = Object.entries(heraldByFile())
      .filter(([file, n]) => n > (baseline[file] ?? 0))
      .map(([file, n]) => `${file} : ${n} ligne(s), limite ${baseline[file] ?? 0}`);
    expect(over).toEqual([]);
  });
});
