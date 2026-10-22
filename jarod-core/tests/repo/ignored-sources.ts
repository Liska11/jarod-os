/**
 * Garde B16 : aucun fichier source sous `packages/` ne doit être ignoré par git.
 *
 * La règle `tools/` (voulue pour le dossier utilisateur à la racine) masquait `packages/plugins/tools/` et,
 * casse ignorée sous Windows (`core.ignorecase`), l'écran SANK-UI `screens/Tools/` : 26 fichiers jamais
 * versionnés, HEAD ne compilait pas depuis un clone. On demande à git lui-même (mêmes règles, même casse que
 * le dépôt) la liste des chemins ignorés sous `packages/`, repliés par dossier ; seuls les produits de
 * construction et de dépendances sont admis.
 */
import { execFileSync } from "node:child_process";

/** Segments de chemin dont tout le contenu est un produit (dépendances, construction, couverture). */
export const ALLOWED_SEGMENTS: ReadonlySet<string> = new Set(["node_modules", "dist", "out", "coverage"]);
/** Fichiers produits admis n'importe où (journaux). */
const ALLOWED_FILE = /\.log$/i;

export function isAllowedIgnored(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.some((p) => ALLOWED_SEGMENTS.has(p))) return true;
  const last = parts[parts.length - 1] ?? "";
  return !path.endsWith("/") && ALLOWED_FILE.test(last);
}

/**
 * Chemins (relatifs au dépôt, `/` final pour un dossier) ignorés sous `packages/` qui ne sont pas des produits.
 * `--ignored=matching` : git rend le chemin qui correspond à une règle (un dossier ignoré en entier apparaît une
 * fois, sans ses fichiers — `node_modules` n'est pas parcouru), jamais ses ancêtres simplement non suivis.
 */
export function ignoredSources(repoRoot: string, scope = "packages", env: NodeJS.ProcessEnv = process.env): string[] {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal", "--", scope], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter((e) => e.startsWith("!! "))
    .map((e) => e.slice(3))
    .filter((p) => !isAllowedIgnored(p))
    .sort();
}
