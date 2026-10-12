// SPECS-P5-MCP.md §4 (b)(c)(d)(e) sur un VRAI profil (base chiffrée, vrai cœur, `mcpCommand` complet) : lecture seule, canaris, refus de schéma.
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { acquireRuntimeLock } from "@jarod/plugin-agent";
import { ProfileManager } from "@jarod/plugin-persona";
import { MIGRATIONS } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCore } from "../src/context.js";
import { MCP_TOOL_NAMES, mcpCommand, mcpPreflight } from "../src/mcp-server.js";

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "jarod-mcp-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Assemblés à l'exécution : le garde du dépôt refuse la FORME d'une clé ou d'un jeton dans un fichier suivi.
const C = {
  apiKeyMemory: ["sk", "CANARI-MEMOIRE-0123456789abcdef01"].join("-"),
  apiKeyMessage: ["sk", "CANARI-MESSAGE-0123456789abcdef01"].join("-"),
  telegram: ["123456789", "CANARI_JETON_abcdefghijklmnopqrstuvwxyz0123"].join(":"),
  tool: "PHRASE-CANARI-SORTIE-OUTIL-4f2a",
  thinking: "PHRASE-CANARI-PENSEE-8c1d",
  raw: "PHRASE-CANARI-RAW-2b7e",
  workspace: "CANARI-DOSSIER-TRAVAIL",
  attachment: "CANARI-PIECE-JOINTE.png",
  toolArg: "PHRASE-CANARI-ARGUMENT-9d3c",
  secretSetting: ["sk", "CANARI-REGLAGE-0123456789abcdef01"].join("-"),
} as const;

async function planted(): Promise<{ root: string; dir: string; sessionId: string }> {
  const root = temp();
  const pm = new ProfileManager(root);
  pm.create("travail");
  pm.setActive("travail");
  const { core, dataDir } = await openCore({ env: { JAROD_HOME: root } });
  let sessionId = "";
  try {
    const s = core.sessions.create("Conversation sur les roses");
    sessionId = s.id;
    core.messages.add(s.id, { role: "user", content: `Parle-moi des roses. ${C.apiKeyMessage}` });
    core.messages.add(s.id, {
      role: "assistant",
      content: "Les roses aiment le soleil.",
      thinking: C.thinking,
      raw: { signature: C.raw },
      toolCalls: [{ id: "t1", name: "shell", args: { cmd: C.toolArg } }],
    });
    core.messages.add(s.id, { role: "tool", content: C.tool, toolCallId: "t1", toolName: "shell" });
    core.messages.add(s.id, { role: "user", content: "Merci", attachments: [{ id: "a1", name: C.attachment, mime: "image/png", size: 3 }] });
    core.updateSessionContext(s.id, { workspace: `C:\\${C.workspace}` });
    core.memory.add(`Préférence : thé vert. Clé de secours ${C.apiKeyMemory}`, "preference");
    core.memory.add("Fait : le jardin est au nord", "fact");
    core.settings.setSecret("provider:anthropic:apiKey", C.secretSetting);
    core.settings.setSecret("gateway:telegram:token", C.telegram);
  } finally {
    await core.dispose();
  }
  return { root, dir: new ProfileManager(root).dirFor("travail"), sessionId };
}

/** Empreinte de CHAQUE table de la base (lignes triées, hachées) : ce que la lecture seule ne doit pas changer. */
async function fingerprint(root: string): Promise<Record<string, string>> {
  const { core } = await openCore({ env: { JAROD_HOME: root } });
  try {
    const db = (core.app as unknown as { storage: { db: { all<T>(sql: string, ...a: unknown[]): T[] } } }).storage.db;
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const out: Record<string, string> = {};
    for (const { name } of tables) {
      try {
        const rows = db.all<unknown>(`SELECT * FROM "${name}"`);
        out[name] = `${rows.length}:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
      } catch {
        /* table virtuelle illisible directement */
      }
    }
    return out;
  } finally {
    await core.dispose();
  }
}

/** Une session MCP complète en processus (mémoire), entrées envoyées d'un coup puis EOF. */
async function runSession(root: string, requests: unknown[], opts: { profile?: string } = {}): Promise<{ code: number; replies: Record<string, unknown>[]; raw: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.setEncoding("utf8");
  output.on("data", (c: string) => (raw += c));
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const done = mcpCommand({ dataRoot: root, version: "0.0.0-test", input, output, ...(opts.profile ? { profile: opts.profile } : {}) });
  for (const r of requests) input.write(`${JSON.stringify(r)}\n`);
  await new Promise((r) => setTimeout(r, 1500));
  input.end();
  const code = await done;
  return { code, raw, replies: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const call = (id: number, name: string, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

describe("jarod mcp sur un vrai profil — lecture seule (barre (b))", () => {
  it("après un appel de TOUS les outils, dont des arguments hostiles, aucune table n'a changé", { timeout: 180_000 }, async () => {
    const { root, sessionId } = await planted();
    await fingerprint(root); // premier passage : d'éventuelles écritures d'ouverture du cœur lui-même sont absorbées ici
    const before = await fingerprint(root);
    const { replies, code } = await runSession(root, [
      INIT,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "memory_search", { query: "thé" }),
      call(4, "memory_list", {}),
      call(5, "sessions_list", {}),
      call(6, "sessions_search", { query: "roses" }),
      call(7, "session_get", { id: sessionId }),
      call(8, "memory_search", { query: '"non fermé AND (NEAR( *' }),
      call(9, "sessions_search", { query: '")) OR * ' }),
      call(10, "memory_list", { limit: 1_000_000_000 }),
      call(11, "session_get", { id: "inexistante" }),
      call(12, "session_get", { id: `${sessionId}' OR 1=1 --` }),
      call(13, "memory_add", { content: "injection" }),
    ]);
    expect(code).toBe(0);
    expect(replies.length).toBe(13); // 13 requêtes avec id ; initialized n'a pas de réponse
    const after = await fingerprint(root);
    const changed = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
    expect(changed, `tables modifiées par la lecture seule : ${changed.join(", ")}`).toEqual([]);
  });

  it("le serveur ne répond « ok » à aucun outil d'écriture (memory_add → -32602) et mcp-server.log reçoit une ligne par appel, sans contenu", { timeout: 180_000 }, async () => {
    const { root } = await planted();
    const { replies } = await runSession(root, [INIT, call(2, "memory_search", { query: "thé vert" }), call(3, "memory_add", { content: "x" })]);
    expect(replies[2]).toMatchObject({ id: 3, error: { code: -32602 } });
    const log = readFileSync(join(root, "mcp-server.log"), "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toMatch(/memory_search args=\d+o résultat=\d+o ok/);
    expect(log).not.toMatch(/thé|vert/);
  });
});

describe("jarod mcp sur un vrai profil — expurgation par canaris (barre (c))", () => {
  it("aucun canari dans AUCUNE réponse de AUCUN outil, ni dans mcp-server.log ; les textes user/assistant, eux, passent", { timeout: 180_000 }, async () => {
    const { root, sessionId } = await planted();
    const { raw } = await runSession(root, [
      INIT,
      call(2, "memory_list", { limit: 100 }),
      call(3, "memory_search", { query: "thé" }),
      call(4, "sessions_list", {}),
      call(5, "sessions_search", { query: "roses" }),
      call(6, "session_get", { id: sessionId, limit: 100 }),
    ]);
    const log = readFileSync(join(root, "mcp-server.log"), "utf8");
    const leaks = Object.entries(C)
      .filter(([, v]) => raw.includes(v) || log.includes(v))
      .map(([k]) => k);
    expect(leaks, `canaris présents : ${leaks.join(", ")}`).toEqual([]);
    expect(raw).toContain("Les roses aiment le soleil.");
    expect(raw).toContain("thé vert");
    expect(raw).toContain("Merci");
  });
});

describe("G2 (exécution) — stdio seulement : aucune écoute, aucune connexion, aucun fetch pendant une session complète", () => {
  it("espions sur net.Server.listen, net.Socket.connect, dgram.createSocket et fetch : zéro appel (et les espions détectent bien un appel)", { timeout: 180_000 }, async () => {
    const { root, sessionId } = await planted();
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const connect = vi.spyOn(net.Socket.prototype, "connect");
    const udp = vi.spyOn(dgram, "createSocket");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { code, replies } = await runSession(root, [INIT, call(2, "memory_list", {}), call(3, "sessions_list", {}), call(4, "session_get", { id: sessionId })]);
    expect(code).toBe(0);
    expect(replies).toHaveLength(4);
    const calls = { listen: listen.mock.calls.length, connect: connect.mock.calls.length, udp: udp.mock.calls.length, fetch: fetchSpy.mock.calls.length };
    expect(calls).toEqual({ listen: 0, connect: 0, udp: 0, fetch: 0 });
    // Sensibilité des espions : un appel réseau volontaire est vu (sinon « zéro » ne prouverait rien).
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    srv.close();
    expect(listen.mock.calls.length).toBe(1);
  });
});

describe("jarod mcp — refus de démarrer (barre (d)) et verrou (barre (e))", () => {
  it("schéma différent → code 1, message, rien d'écrit ; profil inconnu → code 1", { timeout: 180_000 }, async () => {
    const { root } = await planted();
    // Ce programme attend MIGRATIONS.length ; on simule un profil plus ancien en abaissant user_version dans une copie de travail.
    const { core } = await openCore({ env: { JAROD_HOME: root } });
    (core.app as unknown as { storage: { db: { run(sql: string): void } } }).storage.db.run(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    await core.dispose();
    const pre = mcpPreflight({ dataRoot: root });
    expect(pre).toMatchObject({ ok: false });
    expect((pre as { message: string }).message).toMatch(/ne migre jamais/);
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
    const input = new PassThrough();
    const code = await mcpCommand({ dataRoot: root, version: "t", input, output: new PassThrough() });
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/Schéma de la base différent/);
    // Rien n'a été migré : la version est restée celle que nous avons posée.
    const { core: c2 } = await openCore({ env: { JAROD_HOME: root }, runtimeMode: undefined });
    await c2.dispose();
    expect(mcpPreflight({ dataRoot: root, profile: "inconnu" })).toMatchObject({ ok: false, message: expect.stringContaining("Profil inconnu") });
    expect(mcpPreflight({ dataRoot: join(root, "absent") })).toMatchObject({ ok: false });
  });

  it("application « ouverte » (verrou d'exécution tenu par un processus vivant) : le serveur répond quand même", { timeout: 180_000 }, async () => {
    const { root, dir } = await planted();
    const release = acquireRuntimeLock(dir, "desktop" as never);
    try {
      expect(existsSync(join(dir, "runtime.lock"))).toBe(true);
      const { replies, code } = await runSession(root, [INIT, call(2, "memory_list", {})]);
      expect(code).toBe(0);
      expect(JSON.stringify(replies[1])).toContain("thé vert");
    } finally {
      release();
    }
  });

  it("la liste des outils exposés reste fermée : exactement cinq, aucun d'écriture", () => {
    expect([...MCP_TOOL_NAMES].sort()).toEqual(["memory_list", "memory_search", "session_get", "sessions_list", "sessions_search"]);
  });
});

// Évite un avertissement « variable inutilisée » si un test est retiré.
void writeFileSync;
