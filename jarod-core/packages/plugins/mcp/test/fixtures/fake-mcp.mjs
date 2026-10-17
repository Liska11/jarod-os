// Minimal MCP server over stdio used by the tests.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
console.log("not json: servers sometimes log to stdout");

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: process.env.FAKE_ECHO_DESC ?? "Répète le texte",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          { name: "boom", description: "Échoue", inputSchema: { type: "object", properties: {} } },
          ...(process.env.FAKE_EXTRA_TOOL ? [{ name: "extra", description: "Nouvel outil", inputSchema: { type: "object", properties: {} } }] : []),
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    if (msg.params.name === "echo")
      send({ id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params.arguments.text}` }] } });
    else send({ id: msg.id, result: { content: [{ type: "text", text: "kaboum" }], isError: true } });
  }
});
