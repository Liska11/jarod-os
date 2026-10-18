// Essai guidé de l'extension Firefox sur une PAGE NEUTRE locale. À lancer à la main dans un terminal :
//   cd jarod-core && npx tsx scripts/firefox-reader-trial.ts
// Rien n'est lu sans un « oui » TAPÉ ICI par l'utilisateur. Aucun réglage permanent n'est touché ; tout se ferme à la fin.
import { createInterface } from "node:readline";
import { runTrial } from "../packages/plugins/integrations/src/impl/firefox-trial.js";

if (!process.stdin.isTTY) {
  console.error("Terminal interactif requis : le « oui » doit être tapé par vous. Rien n'a été lancé.");
  process.exit(2);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (summary: string) =>
  new Promise<boolean>((resolve) => {
    rl.question(`\nDEMANDE DE LECTURE\n  ${summary}\n  Autoriser cette lecture unique ? (oui/non) `, (answer) => resolve(answer.trim().toLowerCase() === "oui"));
  });

const result = await runTrial({ out: (line) => console.log(line), ask });

rl.close();
console.log(result.read ? "\nEssai terminé : une lecture, affichée ci-dessus. Canal et page fermés." : `\nEssai terminé sans lecture (${result.reason ?? "refusée"}). Canal et page fermés.`);
console.log(`Audit (sans contenu) : ${JSON.stringify(result.audits)}`);
process.exit(0);
