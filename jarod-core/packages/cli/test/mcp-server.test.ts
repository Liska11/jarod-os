// SPECS-P5-MCP.md §3-§4 : protocole MCP et cinq outils en LECTURE SEULE, sur des données simulées (les barres sur un vrai profil sont dans
// mcp-profile.test.ts, la conformité par client indépendant dans mcp-conformance.test.ts).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERR, RpcError } from "../src/jsonrpc-stdio.js";
import { createMcpServerHandlers, fileAudit, MCP_TOOL_NAMES, mcpClean, type McpData } from "../src/mcp-server.js";

// V-03 : la vue unique des journaux du shell lit ces lignes (`audit-view-model.ts`, `MCP_LINE`) ; changer le format casse la vue.
describe("mcp-server.log", () => {
  it("une ligne par appel, au format que la vue unique des journaux lit", () => {
    const file = join(mkdtempSync(join(tmpdir(), "jarod-mcp-log-")), "mcp-server.log");
    const audit = fileAudit(file);
    audit({ tool: "memory_search", argBytes: 12, resultBytes: 345, ok: true });
    audit({ tool: "sessions_list", argBytes: 2, resultBytes: 0, ok: false });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const format = /^(\S+) (\S+) args=(\d+)o résultat=(\d+)o (ok|erreur)$/;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => format.exec(l)?.slice(2))).toEqual([
      ["memory_search", "12", "345", "ok"],
      ["sessions_list", "2", "0", "erreur"],
    ]);
    expect(Number.isFinite(Date.parse(format.exec(lines[0]!)![1]!))).toBe(true);
  });
});

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
// Assemblé à l'exécution : le garde du dépôt refuse la FORME d'une clé dans un fichier suivi.
const KEY = ["sk", "CANARI-CLE-0123456789abcdef0123"].join("-");

const memories = Array.from({ length: 150 }, (_, i) => ({
  id: `m${i}`,
  type: i % 2 ? ("fact" as const) : ("preference" as const),
  content: `souvenir ${i}`,
  createdAt: T0 + i,
  updatedAt: T0 + i,
}));
memories[3]!.content = `ma clé est ${KEY} gardez-la`;

const messages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `x${i}`,
    sessionId: "s1",
    role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
    content: `message ${i}`,
    createdAt: T0 + i,
  }));

function fakeData(over: Partial<McpData> = {}): McpData {
  return {
    memorySearch: (q, limit) => memories.filter((m) => m.content.includes(q)).slice(0, limit),
    memoryList: (type, limit) => memories.filter((m) => !type || m.type === type).slice(0, limit),
    sessionsList: (limit) =>
      Array.from({ length: 80 }, (_, i) => ({
        id: `s${i}`,
        title: `titre ${i}`,
        createdAt: T0,
        updatedAt: T0 + i,
        pinned: false,
        messageCount: i,
      })).slice(0, limit),
    sessionsSearch: (q, limit) => [{ sessionId: "s1", title: `trouvé ${q}`, snippet: `…[${q}]…`, updatedAt: T0 }].slice(0, limit),
    sessionGet: (id) => (id === "s1" ? { id, title: "Conversation un", createdAt: T0, updatedAt: T0, pinned: false, messageCount: 7 } : undefined),
    messages: () => messages(7),
    ...over,
  };
}

function setup(over: Partial<McpData> = {}) {
  const audit: { tool: string; argBytes: number; resultBytes: number; ok: boolean }[] = [];
  const h = createMcpServerHandlers({ data: fakeData(over), version: "9.9.9", audit: (e) => audit.push(e) });
  const call = (method: string, params?: unknown) => h.onRequest(method, params);
  const init = (protocolVersion = "2025-06-18") => call("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const tool = async (name: string, args: unknown = {}) => {
    const r = (await call("tools/call", { name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
    return { r, text: r.content[0]!.text, isError: r.isError === true };
  };
  return { h, call, init, tool, audit };
}

describe("MCP : cycle de vie et protocole", () => {
  it("initialize : renvoie la version du client si supportée, sinon la nôtre ; capacités = tools seulement ; serverInfo", async () => {
    const a = setup();
    const r1 = (await a.init("2025-03-26")) as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } };
    expect(r1.protocolVersion).toBe("2025-03-26");
    expect(Object.keys(r1.capabilities)).toEqual(["tools"]);
    expect(r1.serverInfo).toEqual({ name: "jarod", version: "9.9.9" });
    const b = setup();
    expect(((await b.init("2099-01-01")) as { protocolVersion: string }).protocolVersion).toBe("2025-11-25"); // inconnue du client futur : notre plus récente
    for (const v of ["2025-11-25", "2025-06-18", "2024-11-05"]) expect(((await setup().init(v)) as { protocolVersion: string }).protocolVersion).toBe(v);
  });

  it("avant initialize : seul ping répond ; tools/list et tools/call → -32600", async () => {
    const a = setup();
    await expect(a.call("ping")).resolves.toEqual({});
    await expect(a.call("tools/list")).rejects.toMatchObject({ code: ERR.invalidRequest });
    await expect(a.call("tools/call", { name: "memory_list" })).rejects.toMatchObject({ code: ERR.invalidRequest });
  });

  it("méthode inconnue (y compris resources/*, prompts/*, non annoncées) → -32601", async () => {
    const a = setup();
    await a.init();
    for (const m of ["resources/list", "prompts/list", "completion/complete", "tools/inconnu", "logging/setLevel"])
      await expect(a.call(m)).rejects.toMatchObject({ code: ERR.methodNotFound });
  });

  it("notifications : initialized et cancelled sont acceptées sans erreur", async () => {
    const a = setup();
    await expect(Promise.resolve(a.h.onNotification("notifications/initialized", {}))).resolves.toBeUndefined();
    await expect(Promise.resolve(a.h.onNotification("notifications/cancelled", { requestId: 1 }))).resolves.toBeUndefined();
  });
});

describe("MCP : tools/list", () => {
  it("exactement les cinq outils, tous annotés lecture seule, schémas objet fermés", async () => {
    const a = setup();
    await a.init();
    const { tools } = (await a.call("tools/list")) as { tools: { name: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[] };
    expect(tools.map((t) => t.name).sort()).toEqual(["memory_list", "memory_search", "session_get", "sessions_list", "sessions_search"]);
    expect([...MCP_TOOL_NAMES].sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.description.length).toBeGreaterThan(20);
    }
    // Aucun outil d'écriture ni d'envoi, jamais (Q1/Q2).
    expect(tools.map((t) => t.name).join(" ")).not.toMatch(/add|send|write|delete|respond|ask|rag/);
  });
});

describe("MCP : tools/call", () => {
  it("outil inconnu → -32602 ; arguments non-objet → isError", async () => {
    const a = setup();
    await a.init();
    await expect(a.call("tools/call", { name: "memory_add", arguments: { content: "x" } })).rejects.toMatchObject({ code: ERR.invalidParams });
    await expect(a.call("tools/call", {})).rejects.toBeInstanceOf(RpcError);
    expect((await a.tool("memory_search", "pas un objet")).isError).toBe(true);
  });

  it("memory_search : requête obligatoire (isError sinon) ; limit borné à 50 côté serveur, par défaut 20", async () => {
    const seen: number[] = [];
    const a = setup({ memorySearch: (_q, limit) => (seen.push(limit), []) });
    await a.init();
    expect((await a.tool("memory_search", {})).isError).toBe(true);
    expect((await a.tool("memory_search", { query: "   " })).isError).toBe(true);
    await a.tool("memory_search", { query: "souvenir" });
    await a.tool("memory_search", { query: "souvenir", limit: 1_000_000 });
    await a.tool("memory_search", { query: "souvenir", limit: 3 });
    expect(seen).toEqual([20, 50, 3]);
    for (const bad of [0, -1, 2.5, "abc", null, NaN]) expect((await a.tool("memory_search", { query: "x", limit: bad })).isError).toBe(true);
  });

  it("memory_list : type facultatif parmi les types connus ; limit ≤ 100", async () => {
    const a = setup();
    await a.init();
    const all = JSON.parse((await a.tool("memory_list", { limit: 100_000 })).text) as { items: { id: string; type: string; text: string; at: string }[] };
    expect(all.items.length).toBe(100);
    expect(all.items[0]).toMatchObject({ id: "m0", type: "preference", text: "souvenir 0" });
    expect(all.items[0]!.at).toBe(new Date(T0).toISOString());
    const prefs = JSON.parse((await a.tool("memory_list", { type: "preference" })).text) as { items: { type: string }[] };
    expect(prefs.items.every((m) => m.type === "preference")).toBe(true);
    expect((await a.tool("memory_list", { type: "secret" })).isError).toBe(true);
  });

  it("sessions_list et sessions_search : champs publics seulement (id, titre, nombre de messages, date, extrait)", async () => {
    const a = setup();
    await a.init();
    const list = JSON.parse((await a.tool("sessions_list", { limit: 5 })).text) as { items: Record<string, unknown>[] };
    expect(list.items).toHaveLength(5);
    expect(Object.keys(list.items[0]!).sort()).toEqual(["at", "id", "messages", "title"]);
    const hits = JSON.parse((await a.tool("sessions_search", { query: "mot" })).text) as { items: Record<string, unknown>[] };
    expect(Object.keys(hits.items[0]!).sort()).toEqual(["at", "id", "snippet", "title"]);
  });

  it("session_get : messages user/assistant seulement, dans l'ordre, sans tool/thinking/raw/pièces jointes/dossier ; id inconnu → isError", async () => {
    const rich = [
      { id: "a", sessionId: "s1", role: "user" as const, content: "bonjour", createdAt: T0 },
      { id: "b", sessionId: "s1", role: "assistant" as const, content: "salut", thinking: "CANARI-PENSEE", raw: { c: "CANARI-RAW" }, toolCalls: [{ id: "t", name: "shell", args: { cmd: "CANARI-ARGS" } }], createdAt: T0 + 1 },
      { id: "c", sessionId: "s1", role: "tool" as const, content: "CANARI-SORTIE-OUTIL", toolName: "shell", createdAt: T0 + 2 },
      { id: "d", sessionId: "s1", role: "assistant" as const, content: "", toolCalls: [{ id: "u", name: "x", args: {} }], createdAt: T0 + 3 },
      { id: "e", sessionId: "s1", role: "assistant" as const, content: "RESUME-COMPACTION", kind: "summary" as const, createdAt: T0 + 4 },
      { id: "f", sessionId: "s1", role: "user" as const, content: "merci", attachments: [{ id: "p", name: "CANARI-PIECE.png", mime: "image/png", size: 1 }], createdAt: T0 + 5 },
    ];
    const a = setup({
      messages: () => rich,
      sessionGet: (id) => (id === "s1" ? { id, title: "T", createdAt: T0, updatedAt: T0, pinned: false, messageCount: 6, context: { workspace: "C:\\CANARI-DOSSIER", provider: "p", model: "m", agentMode: "build" } } : undefined),
    });
    await a.init();
    const { text } = await a.tool("session_get", { id: "s1" });
    const out = JSON.parse(text) as { session: Record<string, unknown>; messages: { n: number; role: string; text: string; at: string }[] };
    expect(out.messages.map((m) => [m.role, m.text])).toEqual([["user", "bonjour"], ["assistant", "salut"], ["user", "merci"]]);
    expect(Object.keys(out.session).sort()).toEqual(["id", "messages", "title"]);
    expect(text).not.toMatch(/CANARI|RESUME-COMPACTION/);
    expect((await a.tool("session_get", { id: "inconnue" })).isError).toBe(true);
    expect((await a.tool("session_get", {})).isError).toBe(true);
  });

  it("session_get : pagination par `before` (indices stables), limit ≤ 100, nextBefore quand il en reste", async () => {
    const a = setup({ messages: () => messages(250) });
    await a.init();
    const p1 = JSON.parse((await a.tool("session_get", { id: "s1", limit: 100_000 })).text) as { messages: { n: number }[]; nextBefore?: number };
    expect(p1.messages).toHaveLength(100);
    expect(p1.messages[0]!.n).toBe(150);
    expect(p1.messages.at(-1)!.n).toBe(249);
    expect(p1.nextBefore).toBe(150);
    const p2 = JSON.parse((await a.tool("session_get", { id: "s1", limit: 100, before: p1.nextBefore })).text) as { messages: { n: number }[]; nextBefore?: number };
    expect(p2.messages[0]!.n).toBe(50);
    const p3 = JSON.parse((await a.tool("session_get", { id: "s1", limit: 100, before: 50 })).text) as { messages: { n: number }[]; nextBefore?: number };
    expect(p3.messages).toHaveLength(50);
    expect(p3.nextBefore).toBeUndefined();
    expect((await a.tool("session_get", { id: "s1", before: -3 })).isError).toBe(true);
  });
});

describe("MCP : expurgation, bornes, audit, erreurs", () => {
  it("toute sortie passe par redactText (clé factice dans un souvenir, un titre, un message)", async () => {
    const a = setup({
      sessionsList: () => [{ id: "s1", title: `titre ${KEY}`, createdAt: T0, updatedAt: T0, pinned: false, messageCount: 1 }],
      messages: () => [{ id: "a", sessionId: "s1", role: "user", content: `voici ${KEY}`, createdAt: T0 }],
    });
    await a.init();
    for (const [name, args] of [["memory_list", {}], ["sessions_list", {}], ["session_get", { id: "s1" }], ["memory_search", { query: "souvenir" }]] as const) {
      const { text } = await a.tool(name, args);
      expect(text).not.toContain("CANARI-CLE");
    }
    expect((await a.tool("memory_search", { query: "clé" })).text).toContain("[masqué]");
  });

  it("bornes : un message est tronqué à 4 000 caractères (marqué), la réponse entière à 30 000 caractères (truncated: true)", async () => {
    const big = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, sessionId: "s1", role: "user" as const, content: "é".repeat(6000), createdAt: T0 + i }));
    const a = setup({ messages: () => big });
    await a.init();
    const { text } = await a.tool("session_get", { id: "s1", limit: 100 });
    expect(text.length).toBeLessThanOrEqual(30_000);
    const out = JSON.parse(text) as { messages: { text: string }[]; truncated?: boolean };
    expect(out.truncated).toBe(true);
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages.every((m) => m.text.length <= 4_000 + 20)).toBe(true);
    expect(out.messages[0]!.text).toMatch(/tronqué/);
  });

  it("une exception de la source → isError générique SANS détail interne (chemin, SQL)", async () => {
    const a = setup({ memorySearch: () => { throw new Error("SQLITE_CORRUPT C:\\Users\\x\\jarod.db"); } });
    await a.init();
    const { isError, text } = await a.tool("memory_search", { query: "x" });
    expect(isError).toBe(true);
    expect(text).not.toMatch(/SQLITE|Users|jarod\.db/);
  });

  it("audit : une entrée par appel (outil, tailles, ok/erreur), JAMAIS le contenu des arguments ni du résultat", async () => {
    const a = setup();
    await a.init();
    await a.tool("memory_search", { query: "souvenir 5" });
    await a.tool("memory_search", {});
    expect(a.audit).toHaveLength(2);
    expect(a.audit[0]).toMatchObject({ tool: "memory_search", ok: true });
    expect(a.audit[1]).toMatchObject({ tool: "memory_search", ok: false });
    expect(a.audit[0]!.argBytes).toBeGreaterThan(0);
    expect(a.audit[0]!.resultBytes).toBeGreaterThan(0);
    expect(JSON.stringify(a.audit)).not.toContain("souvenir 5");
  });
});

describe("MCP : expurgation durcie — règle à clé explicite (décision du 2026-10-02)", () => {
  const sensitive = [
    "PASSWORD=abc12345",
    'password: "hunter2"',
    "passwd = ab",
    "pwd=x9",
    "secret: sesame",
    "TOKEN=t0k",
    "api_key = xyz",
    "apikey:k",
    "api-key=zz",
    "MY_DB_PASSWORD=court1",
    '{"password":"abcd"}',
  ];
  it("une valeur affectée à password/passwd/pwd/secret/token/apikey/api_key est masquée À TOUTE LONGUEUR", async () => {
    const a = setup({ memorySearch: () => sensitive.map((s, i) => ({ id: `m${i}`, type: "fact" as const, content: `avant ${s} après`, createdAt: T0, updatedAt: T0 })) });
    await a.init();
    const { text } = await a.tool("memory_search", { query: "x" });
    for (const v of ["abc12345", "hunter2", "sesame", "t0k", "xyz", "court1", "abcd"]) expect(text, v).not.toContain(v);
    for (const v of ['"ab"', "=ab ", "x9", ":k ", "=zz"]) expect(text, v).not.toContain(v);
    expect(text.match(/\[masqué\]/g)?.length).toBeGreaterThanOrEqual(sensitive.length);
    expect(text).toContain("avant");
    expect(text).toContain("après");
  });

  it("sans séparateur d'affectation, ou sans clé, le texte ordinaire n'est pas touché ; le seuil générique de 12 reste celui de redactText", async () => {
    const prose = "Le mot de passe est rouge. Un secret santa en décembre. Le token de la machine. La valeur 1234567 seule.";
    const a = setup({ memorySearch: () => [{ id: "m", type: "fact" as const, content: prose, createdAt: T0, updatedAt: T0 }] });
    await a.init();
    expect(JSON.parse((await a.tool("memory_search", { query: "x" })).text).items[0].text).toBe(prose);
  });

  it("s'applique aussi aux titres, extraits de recherche et messages", async () => {
    const a = setup({
      sessionsList: () => [{ id: "s1", title: "config password=titre1", createdAt: T0, updatedAt: T0, pinned: false, messageCount: 1 }],
      sessionsSearch: () => [{ sessionId: "s1", title: "t", snippet: "…secret=extrait…", updatedAt: T0 }],
      messages: () => [{ id: "a", sessionId: "s1", role: "user", content: "mon token=msg9 ici", createdAt: T0 }],
    });
    await a.init();
    for (const [name, args, leak] of [["sessions_list", {}, "titre1"], ["sessions_search", { query: "x" }, "extrait"], ["session_get", { id: "s1" }, "msg9"]] as const)
      expect((await a.tool(name, args)).text, name).not.toContain(leak);
  });
});

describe("MCP : expurgation à clé explicite — défauts trouvés à la revalidation sur copie réelle (2026-10-02)", () => {
  it("IDEMPOTENTE : nettoyer deux fois donne le même texte (pas de « [masqué]] »)", () => {
    for (const s of ["password=abc12345", 'password: "hunter2"', "{token: x9}", "api_key = zz et pwd=ab", '{"secret":"s"}', "sans rien de sensible"])
      expect(mcpClean(mcpClean(s)), s).toBe(mcpClean(s));
    expect(mcpClean("password=abc")).toBe("password=[masqué]");
  });

  it("une valeur qui contient un crochet ou une accolade n'en laisse AUCUNE partie en clair", () => {
    for (const [s, leak] of [["password=ab]cd", "cd"], ["secret=a}b9z", "b9z"], ["token: x[1]y2", "y2"], ["pwd=p]q]r7", "r7"]] as const)
      expect(mcpClean(s), s).not.toContain(leak);
  });

  it("un champ dont la valeur est DÉJÀ masquée n'est pas remasqué", () => {
    expect(mcpClean("password=[masqué]")).toBe("password=[masqué]");
  });
});

