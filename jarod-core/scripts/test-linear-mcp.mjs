#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = join(
  __dirname,
  "..",
  "tools",
  "linear-mcp-server",
  "node_modules",
  "linear-mcp-server",
  "build",
  "index.js"
);

const apiKey = process.env.LINEAR_API_KEY;

if (!apiKey) {
  console.error(
    "❌ LINEAR_API_KEY manquant. PowerShell : $env:LINEAR_API_KEY='lin_api_xxx'"
  );
  process.exit(1);
}

function send(proc, message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        LINEAR_API_KEY: apiKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Timeout au démarrage du serveur Linear MCP"));
    }, 180000);

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.error) {
          clearTimeout(timeout);
          reject(new Error(message.error.message));
          return;
        }

        if (message.id === 1 && message.result) {
          console.log("✅ Initialize OK:", message.result.serverInfo);
          send(proc, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          });
        }

        if (message.id === 2 && message.result) {
          const tools = message.result.tools ?? [];
          clearTimeout(timeout);
          console.log(
            "✅ Tools list:",
            tools.map((tool) => tool.name).join(", ")
          );
          resolve({ proc, tools });
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      console.error("STDERR:", chunk.toString().trim());
    });

    send(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "jarod-test",
          version: "0.1.0",
        },
      },
    });
  });
}

function callTool(proc, name, args) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    let buffer = "";

    const timeout = setTimeout(() => {
      proc.stdout.off("data", onData);
      reject(new Error(`Timeout pour l'outil ${name}`));
    }, 30000);

    function onData(chunk) {
      buffer += chunk.toString();

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id !== id) continue;

        clearTimeout(timeout);
        proc.stdout.off("data", onData);

        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
        return;
      }
    }

    proc.stdout.on("data", onData);

    send(proc, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    });
  });
}

async function safeCall(proc, name, args) {
  try {
    const result = await callTool(proc, name, args);
    console.log(`✅ ${name}:`, JSON.stringify(result, null, 2).slice(0, 1000));
  } catch (error) {
    console.error(`❌ ${name} failed:`, error.message.slice(0, 400));
  }
}

async function main() {
  console.log("🔧 Démarrage Linear MCP server...");
  const { proc, tools } = await startServer();
  console.log(`📋 ${tools.length} outil(s) disponible(s)`);

  console.log(
    "\n📐 Schémas des outils:\n",
    JSON.stringify(
      tools.map((tool) => ({ name: tool.name, schema: tool.inputSchema })),
      null,
      2
    )
  );

  try {
    console.log("\n📖 Test: linear_get_user_issues");
    await safeCall(proc, "linear_get_user_issues", { limit: 5 });

    console.log("\n📖 Test: linear_search_issues");
    await safeCall(proc, "linear_search_issues", { query: "a", limit: 5 });

    console.log("\n🏁 Test terminé");
  } finally {
    proc.kill();
  }
}

main().catch((error) => {
  console.error("💥 Fatal:", error.message);
  process.exit(1);
});