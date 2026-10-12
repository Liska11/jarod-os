// Faux démon pour les tests de `jarod headless` : mêmes fichiers d'état que `jarod serve` (supervisor.json), sans noyau.
//   node fake-serve.mjs <dossier-données> [normal | ignore-stop | die]
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, mode = "normal"] = process.argv.slice(2);
if (mode === "die") {
  console.error("boum : démarrage impossible");
  process.exit(3);
}
const file = join(root, "supervisor.json");
writeFileSync(file, JSON.stringify({ pid: process.pid, mode: "serve", startedAt: Date.now(), version: "fake", profile: "travail", dataDir: root, stopRequestedAt: null }));
setInterval(() => {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (mode !== "ignore-stop" && state.stopRequestedAt) {
      rmSync(file, { force: true });
      process.exit(0);
    }
  } catch {
    /* fichier en cours d'écriture : au prochain tour */
  }
}, 100);
