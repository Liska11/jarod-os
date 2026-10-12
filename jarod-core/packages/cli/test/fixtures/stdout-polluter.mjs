// Précharge de test (SPECS-P5-MCP.md §4 (a)) : un « plugin » qui fait console.log pendant que le serveur MCP tourne.
// Il n'agit que dans le processus du serveur (argv[1] = main.ts) et seulement quand le test a posé le fichier-marqueur.
import { existsSync } from "node:fs";
const marker = process.env.JAROD_POLLUTE_MARKER;
if (marker && String(process.argv[1]).endsWith("main.ts")) {
  setInterval(() => {
    if (existsSync(marker)) console.log("PAS-DU-JSON (plugin bavard)");
  }, 50).unref();
}
