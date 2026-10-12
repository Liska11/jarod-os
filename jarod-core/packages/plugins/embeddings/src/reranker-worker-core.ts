/**
 * Cœur du processus dédié du reranker (SPECS-P5-RERANKER.md §2.2) : il porte SEUL le moteur OpenVINO (bge-reranker-v2-m3 INT8, IR à
 * formes statiques) et le point d'accès `POST /v1/rerank` sur 127.0.0.1. Un plantage natif tue ce processus, plus l'application ;
 * l'hôte (`reranker-isolated.ts`) le relance. Même schéma que `embeddings-worker-core.ts`, avec UNE différence due au NPU : la
 * compilation dure ≈ 90 s à froid, donc le démarrage se fait en deux temps — `listening` dès que le port est pris (un port occupé se
 * voit tout de suite), `ready` seulement une fois le modèle compilé ET la sonde passée.
 *
 * Protocole (objets, jamais de texte de document) — hôte → worker : `start {config}`, `shutdown` ; worker → hôte : `listening`,
 * `ready {url, device}`, `error {code, message}` (le worker sort ensuite en code 1), `metrics {metrics}` après chaque requête.
 * Port occupé : `RERANKER_PORT_BUSY`, jamais de repli sur un autre port. Avant `ready`, une requête reçoit 503 `RERANKER_WARMING`.
 */
import { createServer, type Server } from "node:http";
import { RerankerConfig } from "@jarod/contracts";
import type { WorkerIo } from "./embeddings-worker-core.js";
import { OpenVinoReranker, type RerankerMetrics, scoreAll } from "./reranker.js";

export type { WorkerIo };

/** Ce que le worker attend d'un moteur — remplaçable en test. */
export interface RerankerBackend {
  readonly batch: number;
  init(): Promise<void>;
  scoreBatch(query: string, documents: string[]): Promise<number[]>;
  metrics(): RerankerMetrics;
}

export interface RerankerWorkerDeps {
  createEngine?: (cfg: ReturnType<typeof RerankerConfig.parse>) => RerankerBackend;
}

/** Taille maximale d'une requête et nombre maximal de candidats (au-delà, 400 : l'appelant découpe ou borne). */
const MAX_BODY = 4 * 1024 * 1024;
export const MAX_CANDIDATES = 64;

export function runRerankerWorker(io: WorkerIo, deps: RerankerWorkerDeps = {}): void {
  let started = false;
  let server: Server | null = null;

  const fail = (code: string, message: string): void => {
    io.send({ type: "error", code, message });
    io.exit(1);
  };

  io.onMessage((raw) => {
    const msg = raw as { type?: string; config?: unknown } | null;
    if (msg?.type === "shutdown") {
      server?.close();
      io.exit(0);
      return;
    }
    if (msg?.type !== "start" || started) return;
    started = true;

    const parsed = RerankerConfig.safeParse(msg.config);
    if (!parsed.success) return fail("RERANKER_BAD_CONFIG", `configuration du worker invalide : ${parsed.error.issues.map((i) => i.path.join(".") || "(racine)").join(", ")}.`);
    const cfg = parsed.data;
    let engine: RerankerBackend;
    try {
      engine = deps.createEngine ? deps.createEngine(cfg) : new OpenVinoReranker(cfg as never);
    } catch (e) {
      return fail("RERANKER_BAD_CONFIG", (e as Error).message);
    }

    let ready = false;
    const push = () => io.send({ type: "metrics", metrics: engine.metrics() });
    server = createServer((req, res) => {
      res.once("finish", push);
      void handle(req, res);
    });

    const handle = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method === "GET" && req.url === "/v1/models") return reply(200, { object: "list", data: [{ id: "bge-reranker-v2-m3-int8", object: "model" }] });
        if (req.method !== "POST" || req.url !== "/v1/rerank") return reply(404, { error: { code: "NOT_FOUND", message: "introuvable" } });
        if (!ready) return reply(503, { error: { code: "RERANKER_WARMING", message: "modèle en cours de compilation" } });
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) return reply(413, { error: { code: "TOO_LARGE", message: "requête trop volumineuse" } });
          chunks.push(c as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query?: unknown; documents?: unknown };
        const docs = body.documents;
        if (typeof body.query !== "string" || !Array.isArray(docs) || !docs.every((d) => typeof d === "string") || docs.length > MAX_CANDIDATES) {
          return reply(400, { error: { code: "BAD_REQUEST", message: `\`query\` (texte) et \`documents\` (liste de textes, ${MAX_CANDIDATES} au plus) sont requis` } });
        }
        const scores = await scoreAll(engine, body.query, docs as string[]);
        const results = scores.map((relevance_score, index) => ({ index, relevance_score })).sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
        return reply(200, { object: "list", model: "bge-reranker-v2-m3-int8", results });
      } catch (e) {
        // Le message d'une erreur du moteur peut citer un chemin ou une forme, jamais un texte de document : on ne rend que le code.
        const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "RERANKER_FAILED";
        return reply(500, { error: { code, message: code } });
      }
    };

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") fail("RERANKER_PORT_BUSY", `le port ${cfg.port} est déjà utilisé sur 127.0.0.1 (aucun repli sur un autre port).`);
      else fail("RERANKER_LISTEN_FAILED", `écoute impossible sur 127.0.0.1:${cfg.port} : ${err.message}`);
    });
    server.listen(cfg.port, "127.0.0.1", () => {
      io.send({ type: "listening", url: `http://127.0.0.1:${cfg.port}/v1` });
      engine.init().then(
        () => {
          ready = true;
          io.send({ type: "ready", url: `http://127.0.0.1:${cfg.port}/v1`, device: engine.metrics().device });
        },
        (e: unknown) => fail(typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "RERANKER_INIT_FAILED", String((e as Error).message ?? e).slice(0, 300)),
      );
    });
  });
}
