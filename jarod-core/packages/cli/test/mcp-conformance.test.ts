// SPECS-P5-MCP.md §4 (a) : conformité de `jarod mcp` avec le client MCP OFFICIEL (@modelcontextprotocol/client 2.1.0, liste B du 2026-10-02),
// en processus réels. Le SDK n'est qu'une dépendance de test : ni `jarod mcp` ni `jarod acp` ne l'importent.
// Les ÉCARTS constatés contre le SDK sont consignés ici en `it.fails` (le test passe tant que l'écart existe et échouera le jour où il sera
// corrigé, pour qu'on retire la mention) ; ils ont été soumis à l'utilisateur avant toute correction (DECISIONS 2026-10-02).
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, LATEST_PROTOCOL_VERSION, ProtocolError, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProfileManager } from "@jarod/plugin-persona";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCore } from "../src/context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = join(HERE, "..", "src", "main.ts");
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

let root = "";
let sessionId = "";
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "jarod-mcpconf-"));
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  core.memory.add("Préférence : thé vert", "preference");
  const s = core.sessions.create("Conversation sur les roses");
  sessionId = s.id;
  core.messages.add(s.id, { role: "user", content: "Parle-moi des roses" });
  core.messages.add(s.id, { role: "assistant", content: "Les roses aiment le soleil." });
  await core.dispose();
}, 120_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function connect(versionNegotiation?: { mode: "legacy" | "auto" | { pin: string } }): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, MAIN_TS, "mcp"],
    env: { ...(process.env as Record<string, string>), JAROD_HOME: root, VITEST: "" },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (c: Buffer) => (err += c));
  const client = new Client({ name: "jarod-conformance", version: "1.0.0" }, { capabilities: {}, ...(versionNegotiation ? { versionNegotiation } : {}) });
  await client.connect(transport);
  return { client, stderr: () => err };
}

describe("jarod mcp contre le client MCP officiel", () => {
  it("handshake : version négociée connue du SDK, serverInfo, capacités = tools seulement, instructions, ping", { timeout: 120_000 }, async () => {
    const { client, stderr } = await connect();
    try {
      const negotiated = client.getNegotiatedProtocolVersion();
      expect(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).toContain(negotiated);
      expect(client.getServerVersion()).toMatchObject({ name: "jarod" });
      expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual(["tools"]);
      expect(client.getInstructions()).toMatch(/LECTURE SEULE/);
      await expect(client.ping()).resolves.toEqual({});
      expect(stderr()).toMatch(/jarod mcp \(pid \d+\)/);
    } finally {
      await client.close();
    }
  });

  it("tools/list : exactement les cinq outils, schémas objet, annotés lecture seule", { timeout: 120_000 }, async () => {
    const { client } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["memory_list", "memory_search", "session_get", "sessions_list", "sessions_search"]);
      for (const t of tools) {
        expect(t.inputSchema.type).toBe("object");
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.annotations?.destructiveHint).toBe(false);
      }
    } finally {
      await client.close();
    }
  });

  it("tools/call : un appel par outil rend du texte JSON valide ; arguments invalides → résultat isError (choix de v1) ; outil inconnu → ProtocolError -32602", { timeout: 120_000 }, async () => {
    const { client } = await connect();
    try {
      const text = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError ?? false, `${name} : ${JSON.stringify(r.content)}`).toBe(false);
        const c = r.content[0]!;
        expect(c.type).toBe("text");
        return JSON.parse((c as { text: string }).text) as Record<string, unknown>;
      };
      expect(JSON.stringify(await text("memory_list", {}))).toContain("thé vert");
      expect(JSON.stringify(await text("memory_search", { query: "thé" }))).toContain("thé vert");
      expect(JSON.stringify(await text("sessions_list", {}))).toContain("roses");
      expect(JSON.stringify(await text("sessions_search", { query: "roses" }))).toContain(sessionId);
      expect(JSON.stringify(await text("session_get", { id: sessionId }))).toContain("Les roses aiment le soleil.");

      const bad = await client.callTool({ name: "memory_search", arguments: {} });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]).toMatchObject({ type: "text" });

      const unknown = await client.callTool({ name: "memory_add", arguments: { content: "x" } }).catch((e: unknown) => e);
      expect(unknown).toBeInstanceOf(ProtocolError);
      expect((unknown as ProtocolError).code).toBe(-32602);
    } finally {
      await client.close();
    }
  });

  it("négociation `auto` du SDK : repli réussi vers la version classique (pas de blocage)", { timeout: 120_000 }, async () => {
    const { client } = await connect({ mode: "auto" });
    try {
      expect(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).toContain(client.getNegotiatedProtocolVersion());
      expect((await client.listTools()).tools).toHaveLength(5);
    } finally {
      await client.close();
    }
  });

  it("arrêt : fermer le client termine le serveur sans erreur", { timeout: 120_000 }, async () => {
    const { client } = await connect();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe("version de protocole (écart E1 corrigé le 2026-10-02, sur instruction de l'utilisateur)", () => {
  it("le serveur négocie la dernière version classique du SDK (2025-11-25)", { timeout: 120_000 }, async () => {
    const { client } = await connect();
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
    } finally {
      await client.close();
    }
  });
});

describe("ÉCARTS constatés contre le SDK (soumis à l'utilisateur, NON corrigés)", () => {
  // Écart 2 : le SDK implémente la révision « moderne » 2026-07-28 (server/discover) ; un client qui l'impose (pin) ne peut pas se connecter.
  it.fails("écart 2 — révision moderne 2026-07-28 (server/discover) non prise en charge : un client en mode `pin` échoue", { timeout: 120_000 }, async () => {
    const { client } = await connect({ mode: { pin: "2026-07-28" } });
    await client.close();
  });
});
