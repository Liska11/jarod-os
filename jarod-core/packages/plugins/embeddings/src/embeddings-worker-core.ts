/**
 * Cœur du processus dédié d'embeddings (SPECS-P5-EMBEDDINGS.md §3.2) : il porte SEUL le moteur OpenVINO (bge-m3) et le point
 * d'accès `/v1/embeddings` sur 127.0.0.1. Un plantage natif (cf. Q9 : 0xC0000005 dans `inferAsync` sur NPU) tue ce processus, plus
 * l'application ; l'hôte (`isolated.ts`) le relance. Lancé par `embeddings-worker.mjs` (tsx) : `utilityProcess` sous Electron,
 * `child_process.fork` ailleurs.
 *
 * Protocole (objets, jamais de texte de document) — hôte → worker : `start {config}`, `shutdown` ; worker → hôte :
 * `ready {url}`, `error {code, message}` (le worker sort ensuite en code 1), `metrics {metrics}` après chaque requête.
 * Port occupé : `EMBEDDINGS_PORT_BUSY`, jamais de repli sur un autre port (§10.1).
 */
import { createServer, type Server } from "node:http";
import { EmbeddingsConfig } from "@jarod/contracts";
import { type EmbeddingsEngine, EmbeddingsService } from "./index.js";
import { OpenVinoEmbedder } from "./openvino.js";

export interface WorkerIo {
  send(message: unknown): void;
  onMessage(cb: (message: unknown) => void): void;
  exit(code: number): void;
}

export interface WorkerDeps {
  /** Remplaçable en test (faux moteur) ; défaut : le moteur OpenVINO réel. */
  createEngine?: (cfg: ReturnType<typeof EmbeddingsConfig.parse>) => EmbeddingsEngine;
}

export function runEmbeddingsWorker(io: WorkerIo, deps: WorkerDeps = {}): void {
  let started = false;
  let server: Server | null = null;

  const fail = (code: string, message: string): void => {
    io.send({ type: "error", code, message });
    io.exit(1);
  };

  io.onMessage((raw) => {
    const msg = raw as { type?: string; config?: Record<string, unknown> } | null;
    if (msg?.type === "shutdown") {
      server?.close();
      io.exit(0);
      return;
    }
    if (msg?.type !== "start" || started) return;
    started = true;

    const c = msg.config;
    const port = c?.port;
    if (!c || typeof c.modelDir !== "string" || !c.modelDir || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      return fail("EMBEDDINGS_BAD_CONFIG", "configuration du worker invalide : modelDir (texte) et port (entier 1-65535) sont requis.");
    }
    let engine: EmbeddingsEngine;
    try {
      const cfg = EmbeddingsConfig.parse({ ...c, warmup: false });
      engine = deps.createEngine ? deps.createEngine(cfg) : new OpenVinoEmbedder(cfg as never);
    } catch (e) {
      return fail("EMBEDDINGS_BAD_CONFIG", (e as Error).message);
    }

    const service = new EmbeddingsService(engine);
    const push = () => io.send({ type: "metrics", metrics: engine.metrics() });
    server = createServer((req, res) => {
      res.once("finish", push);
      void service.handle(req, res);
    });
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") fail("EMBEDDINGS_PORT_BUSY", `le port ${port} est déjà utilisé sur 127.0.0.1 (aucun repli sur un autre port).`);
      else fail("EMBEDDINGS_LISTEN_FAILED", `écoute impossible sur 127.0.0.1:${port} : ${err.message}`);
    });
    server.listen(port, "127.0.0.1", () => io.send({ type: "ready", url: `http://127.0.0.1:${port}/v1` }));
  });
}
