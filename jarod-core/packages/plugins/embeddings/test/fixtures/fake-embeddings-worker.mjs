// Faux worker d'embeddings (précédent : fake-docling-worker.mjs) : même protocole que `embeddings-worker.mjs`, sans OpenVINO.
// Reçoit { type: "start", config: { port } } ; répond { type: "ready", url } | { type: "error", code, message } ;
// pousse { type: "metrics", metrics } après chaque requête. Le comportement se règle par FAKE_MODE :
//   ok                 : sert normalement
//   crash-once-on-embed: meurt (0xC0000005) à la première requête d'embeddings de la vie du fichier FAKE_MARKER, sert ensuite
//   crash-after-ready  : meurt tout de suite après « ready », à chaque lancement
//   port-busy          : envoie EMBEDDINGS_PORT_BUSY puis sort en code 1
//   never-ready        : ne répond jamais au « start »
//   slow-ready         : répond « ready » après FAKE_DELAY_MS
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
  if (mode === "never-ready") return;
  if (mode === "port-busy") {
    send({ type: "error", code: "EMBEDDINGS_PORT_BUSY", message: `port ${port} déjà utilisé` });
    setTimeout(() => process.exit(1), 20);
    return;
  }
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "fake", object: "model" }] }));
      }
      if (mode === "crash-once-on-embed" && process.env.FAKE_MARKER && !existsSync(process.env.FAKE_MARKER)) {
        writeFileSync(process.env.FAKE_MARKER, "crashed");
        process.exit(3221225477);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")).input;
      const list = typeof input === "string" ? [input] : input;
      calls += list.length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: list.map((t, index) => ({ object: "embedding", index, embedding: [t.length, 1, 0, 0] })) }));
      send({ type: "metrics", metrics: { available: true, requested: ["NPU"], device: { 128: "NPU" }, attempts: [], calls, texts: calls, p50Ms: 1, p95Ms: 2, lastError: null } });
    });
  });
  server.listen(port, "127.0.0.1", () => {
    const ready = () => {
      send({ type: "ready", url: `http://127.0.0.1:${port}/v1` });
      if (mode === "crash-after-ready") setTimeout(() => process.exit(3221225477), 30);
    };
    if (mode === "slow-ready") setTimeout(ready, Number(process.env.FAKE_DELAY_MS ?? 300));
    else ready();
  });
});
