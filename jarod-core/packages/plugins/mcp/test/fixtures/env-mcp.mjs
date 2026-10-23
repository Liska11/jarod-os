// MCP server that reports WHICH of the asked environment variables it received (names → present or not; never the values).
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "env", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ id: msg.id, result: { tools: [{ name: "has", description: "Which variables are present", inputSchema: { type: "object", properties: { names: { type: "array" } } } }] } });
  } else if (msg.method === "tools/call") {
    const names = msg.params.arguments?.names ?? [];
    const answer = Object.fromEntries(names.map((n) => [n, process.env[n] !== undefined]));
    send({ id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } });
  }
});
