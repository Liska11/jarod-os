// Faux point d'accès OpenAI LOCAL (bouclage) pour les tests de moteurs : un « modèle » scripté, aucune donnée réelle, aucun réseau.
import { createServer, type Server } from "node:http";

export interface FakeCall {
  url: string;
  auth: boolean;
  tools: string[];
  /** Le dernier message est un résultat d'outil. */
  afterTool: boolean;
}

export interface FakeLlm {
  url: string;
  calls: FakeCall[];
  close(): Promise<void>;
}

type Reply = { content: string } | { tool: string; args: Record<string, unknown> };

/** `script` reçoit l'appel et rend la réponse : texte, ou un appel d'outil. */
export function startFakeLlm(script: (call: FakeCall, n: number) => Reply): Promise<FakeLlm> {
  const calls: FakeCall[] = [];
  const srv: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let j: { tools?: { function?: { name?: string } }[]; messages?: { role?: string }[]; stream?: boolean } = {};
      try {
        j = JSON.parse(body);
      } catch {
        // corps vide
      }
      const call: FakeCall = {
        url: req.url ?? "",
        auth: Boolean(req.headers.authorization),
        tools: (j.tools ?? []).map((t) => String(t.function?.name)),
        afterTool: j.messages?.at(-1)?.role === "tool",
      };
      calls.push(call);
      const r = script(call, calls.length);
      const message = "tool" in r ? { role: "assistant", content: null, tool_calls: [{ id: `c${calls.length}`, type: "function", function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: "assistant", content: r.content };
      const finish = "tool" in r ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = "tool" in r ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls![0] }] } : { role: "assistant", content: r.content };
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "fake", choices: [{ index: 0, message, finish_reason: finish }], usage }));
    });
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise((r) => srv.close(() => r())) });
    }),
  );
}
