// Point d'entrée du processus dédié d'embeddings (SPECS-P5-EMBEDDINGS.md §3.2). Exécute le TypeScript par tsx, comme
// `packages/desktop/electron/main.mjs` (le main n'est pas empaqueté avant la release). `utilityProcess` : `process.parentPort` ;
// `child_process.fork` : `process.send` / `process.on("message")`. Voir `embeddings-worker-core.ts`.
import { register } from "tsx/esm/api";

register();
const { runEmbeddingsWorker } = await import("./embeddings-worker-core.ts");

const port = process.parentPort;
runEmbeddingsWorker({
  send: (m) => (port ? port.postMessage(m) : process.send(m)),
  onMessage: (fn) => (port ? port.on("message", (e) => fn(e.data)) : process.on("message", fn)),
  exit: (code) => process.exit(code),
});
// Hôte disparu (fork) : ne jamais rester orphelin.
process.on("disconnect", () => process.exit(0));
