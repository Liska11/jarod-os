// Faux worker du reranker (précédent : fake-embeddings-worker.mjs) : même protocole que `reranker-worker.mjs`, sans OpenVINO.
// Reçoit { type: "start", config: { port } } ; répond { type: "listening" } puis { type: "ready", url } | { type: "error", code, message } ;
// POST /v1/rerank { query, documents } → { results: [{ index, relevance_score }] } (score = longueur du document). FAKE_MODE :
//   ok                    : écoute puis « ready » tout de suite
//   slow-ready            : écoute, « ready » après FAKE_DELAY_MS (compilation simulée)
//   crash-once-on-rerank  : meurt (0xC0000005) à la première requête de la vie du fichier FAKE_MARKER, sert ensuite
//   crash-after-ready     : meurt tout de suite après « ready », à chaque lancement
//   port-busy             : envoie RERANKER_PORT_BUSY puis sort en code 1
//   no-device             : envoie RERANKER_NO_DEVICE puis sort en code 1
//   never-ready           : écoute mais n'annonce jamais « ready »
//   slow-rerank           : répond après FAKE_RERANK_MS
//   hang-rerank           : ne répond JAMAIS à une requête (calcul natif bloqué)
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const mode = process.env.FAKE_MODE ?? "ok";
const send = (m) => process.send(m);
let calls = 0;

process.on("disconnect", () => process.exit(0));
process.on("message", (msg) => {
  if (msg?.type === "shutdown") process.exit(0);
  if (msg?.type !== "start") return;
  const port = msg.config.port;
  if (mode === "port-busy") {
    send({ type: "error", code: "RERANKER_PORT_BUSY", message: `port ${port} déjà utilisé` });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  if (mode === "no-device") {
    send({ type: "error", code: "RERANKER_NO_DEVICE", message: "aucun périphérique" });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (mode === "crash-once-on-rerank" && process.env.FAKE_MARKER && !existsSync(process.env.FAKE_MARKER)) {
        writeFileSync(process.env.FAKE_MARKER, "crashed");
        process.exit(3221225477);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const answer = () => {
        calls += 1;
        const results = body.documents.map((d, index) => ({ index, relevance_score: d.length })).sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", results }));
        send({ type: "metrics", metrics: { available: true, requested: ["NPU"], device: "NPU", attempts: [], calls, candidates: calls, p50Ms: 1, p95Ms: 2, lastError: null } });
      };
      if (mode === "hang-rerank") return;
      if (mode === "slow-rerank") setTimeout(answer, Number(process.env.FAKE_RERANK_MS ?? 500));
      else answer();
    });
  });
  server.listen(port, "127.0.0.1", () => {
    send({ type: "listening", url: `http://127.0.0.1:${port}/v1` });
    const ready = () => {
      send({ type: "ready", url: `http://127.0.0.1:${port}/v1`, device: "NPU" });
      if (mode === "crash-after-ready") setTimeout(() => process.exit(3221225477), 30);
    };
    if (mode === "never-ready") return;
    if (mode === "slow-ready") setTimeout(ready, Number(process.env.FAKE_DELAY_MS ?? 300));
    else ready();
  });
});
