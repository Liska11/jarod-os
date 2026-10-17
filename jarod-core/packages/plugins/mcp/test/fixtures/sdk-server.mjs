// Serveur MCP construit avec le SDK OFFICIEL (@modelcontextprotocol/sdk), pour tester notre client contre le vrai protocole.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "sdk-fixture", version: "1.0.0" });
server.registerTool("add", { description: process.env.SDK_ADD_DESC ?? "Additionne deux nombres", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));
server.registerTool("fail", { description: "Échoue", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "raté" }] }));
await server.connect(new StdioServerTransport());
