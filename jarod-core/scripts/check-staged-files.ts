/**
 * Garde de commit en ligne de commande (crochet `scripts/git-hooks/pre-commit`) : échoue (code 1) si l'index contient un fichier vidé ou
 * presque vidé. Même logique que `tests/repo/staged-files.test.ts`. Dérogation pour un seul commit : `JAROD_ALLOW_EMPTY=1 git commit …`.
 * Installation : `pnpm hooks:install` (règle `core.hooksPath` du dépôt local).
 */
import { readStaged, stagedProblems } from "../tests/repo/staged-files.js";

const problems = stagedProblems(readStaged(process.cwd()));
if (problems.length === 0) process.exit(0);
if (process.env.JAROD_ALLOW_EMPTY === "1") {
  console.error(`Garde de commit : dérogation JAROD_ALLOW_EMPTY=1, ${problems.length} fichier(s) vidé(s) ou presque acceptés :\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(0);
}
console.error(
  `Commit REFUSÉ : fichier(s) vidé(s) ou presque vidé(s) dans l'index (incident du 2026-10-01 : un script d'édition défectueux avait vidé un fichier) :\n${problems.map((p) => `  ${p}`).join("\n")}\n` +
    "Restaurez-les (git restore --staged <fichier> puis git checkout HEAD -- <fichier>) ; si c'est voulu : JAROD_ALLOW_EMPTY=1 git commit …",
);
process.exit(1);
