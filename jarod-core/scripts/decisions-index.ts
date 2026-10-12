/**
 * `pnpm decisions:index` — régénère DECISIONS-INDEX.md (une ligne par décision, groupée par mois, lien vers la ligne de DECISIONS.md).
 * DECISIONS.md n'est pas touché. À relancer après un ajout si l'on veut l'index à jour ; aucun test n'exige la synchronisation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDecisions, renderIndex } from "../tests/repo/decisions-index.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entries = parseDecisions(readFileSync(join(repo, "DECISIONS.md"), "utf8"));
writeFileSync(join(repo, "DECISIONS-INDEX.md"), renderIndex(entries));
console.log(`DECISIONS-INDEX.md : ${entries.length} décisions indexées`);
