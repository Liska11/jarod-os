// Point d'entrée du processus dédié du reranker (SPECS-P5-RERANKER.md §2.2). Exécute le TypeScript par tsx, comme
// `embeddings-worker.mjs`. `utilityProcess` : `process.parentPort` ; `child_process.fork` : `process.send` / `process.on("message")`.
// Voir `reranker-worker-core.ts`.
import { register } from "tsx/esm/api";

register();
const { runRerankerWorker } = await import("./reranker-worker-core.ts");

const port = process.parentPort;
runRerankerWorker({
  send: (m) => (port ? port.postMessage(m) : process.send(m)),
  onMessage: (fn) => (port ? port.on("message", (e) => fn(e.data)) : process.on("message", fn)),
  exit: (code) => process.exit(code),
});
// Hôte disparu (fork) : ne jamais rester orphelin.
process.on("disconnect", () => process.exit(0));
