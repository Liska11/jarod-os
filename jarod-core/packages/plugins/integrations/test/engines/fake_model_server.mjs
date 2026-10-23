// « Serveur de modèle » FACTICE pour le banc llama-swap : imite llama-server (/health, /v1/chat/completions), sans modèle.
//   node fake_model_server.mjs <port> <nom> [délai de chargement ms] [durée de réponse ms]
import { createServer } from "node:http";

const [port, name, loadMs = "300", answerMs = "50"] = process.argv.slice(2);
let ready = false;
setTimeout(() => (ready = true), Number(loadMs));
createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: ready ? "ok" : "loading" }));
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () =>
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: name, pid: process.pid, choices: [{ index: 0, message: { role: "assistant", content: `réponse de ${name}` }, finish_reason: "stop" }] }));
    }, Number(answerMs)),
  );
}).listen(Number(port), "127.0.0.1");
