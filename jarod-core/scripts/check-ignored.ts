/**
 * Garde B16 en ligne de commande : échoue (code 1) si git ignore un fichier source sous `packages/`.
 * Usage : `pnpm check:ignored`. Même logique que le test `tests/repo/ignored-sources.test.ts` (dans `pnpm test`).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ignoredSources } from "../tests/repo/ignored-sources.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bad = ignoredSources(root);
if (bad.length) {
  console.error(`Fichiers sous packages/ ignorés par git (règle .gitignore trop large ?) :\n${bad.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("OK : aucun fichier source ignoré sous packages/.");
