// SPECS-P5-MCP.md : `jarod mcp` — Jarod comme serveur MCP (stdio) pour d'autres agents. LECTURE SEULE : cinq outils, mémoire et historique.
// Gardes figées (§3 bis) : G1 démarrage manuel seulement (rien dans le dépôt ne lance cette commande) ; G2 stdio seulement (ce fichier n'importe
// aucun module réseau et n'ouvre aucun socket) ; G3 avertissement dans l'aide (`main.ts`, HELP).
// Ce serveur n'écrit aucune ligne en base : seul le journal d'audit (`mcp-server.log`, noms d'outils et tailles, JAMAIS de contenu) est écrit.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Memory, MemoryType, Message, SearchHit, Session } from "@jarod/contracts";
import { redactKeyedText } from "@jarod/kernel/redact";
import type { KeyStore } from "@jarod/plugin-storage";
import { openCore } from "./context.js";
import { type Preflight, profilePreflight } from "./preflight.js";
import { ERR, RpcError, serveJsonRpc } from "./jsonrpc-stdio.js";

/**
 * Versions du protocole que nous parlons, la plus récente d'abord. 2025-11-25 ajoutée le 2026-10-02 (écart E1, sur instruction de l'utilisateur) :
 * c'est la dernière version « classique » du SDK officiel ; un serveur à outils seuls n'utilise rien de ce qu'elle ajoute (tâches, élicitation…).
 */
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
const MEMORY_TYPES: readonly MemoryType[] = ["fact", "preference", "context", "conversation"];
const MAX_RESPONSE_CHARS = 30_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TITLE_CHARS = 200;
const MAX_QUERY_CHARS = 500;

/** Ce dont le serveur a besoin, et RIEN d'autre : aucune méthode d'écriture n'y figure (Q2). */
export interface McpData {
  memorySearch(query: string, limit: number): Memory[];
  memoryList(type: MemoryType | undefined, limit: number): Memory[];
  sessionsList(limit: number): Session[];
  sessionsSearch(query: string, limit: number): SearchHit[];
  sessionGet(id: string): Session | undefined;
  messages(sessionId: string): Message[];
}

export interface McpAuditEntry {
  tool: string;
  argBytes: number;
  resultBytes: number;
  ok: boolean;
}

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  read(data: McpData, args: Record<string, unknown>): object;
}

class ArgError extends Error {}

/**
 * La règle à clé explicite vit maintenant dans le noyau (`redactKeyedText`, `packages/kernel/src/redact.ts`) : elle
 * était recopiée ici depuis la décision du 2026-10-02, et deux copies d'un même masque finissent par diverger.
 */
/** Exporté pour la revalidation sur copie réelle (condition de clôture de MCP). */
export const mcpClean = (s: string): string => redactKeyedText(s);
const clean = mcpClean;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[tronqué]` : s);
const iso = (ms: number): string => new Date(ms).toISOString();

function limitArg(args: Record<string, unknown>, def: number, max: number): number {
  const v = args.limit;
  if (v === undefined) return def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ArgError("`limit` doit être un entier d'au moins 1.");
  return Math.min(v, max);
}

function queryArg(args: Record<string, unknown>): string {
  const q = args.query;
  if (typeof q !== "string" || !q.trim()) throw new ArgError("`query` est obligatoire (texte non vide).");
  return q.trim().slice(0, MAX_QUERY_CHARS);
}

const memoryItem = (m: Memory) => ({ id: m.id, type: m.type, text: cut(clean(m.content), MAX_MESSAGE_CHARS), at: iso(m.updatedAt) });
const sessionItem = (s: Session) => ({ id: s.id, title: cut(clean(s.title), MAX_TITLE_CHARS), messages: s.messageCount, at: iso(s.updatedAt) });

/** Messages EXPOSÉS : textes `user` et `assistant` non vides, hors résumés de compaction. Tout le reste est écarté (Q3). */
function exposedMessages(all: Message[]): Message[] {
  return all.filter((m) => (m.role === "user" || m.role === "assistant") && m.kind !== "summary" && m.content.trim() !== "");
}

const TOOLS: ToolSpec[] = [
  {
    name: "memory_search",
    description: "Cherche dans la mémoire à long terme de Jarod (faits, préférences, contexte) par mots-clés. Lecture seule.",
    properties: {
      query: { type: "string", description: "Mots-clés à chercher." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Nombre maximal de résultats (défaut 20)." },
    },
    required: ["query"],
    read: (d, a) => ({ items: d.memorySearch(queryArg(a), limitArg(a, 20, 50)).map(memoryItem) }),
  },
  {
    name: "memory_list",
    description: "Liste les souvenirs les plus récemment modifiés de Jarod, éventuellement d'un seul type. Lecture seule.",
    properties: {
      type: { type: "string", enum: [...MEMORY_TYPES], description: "Limiter à un type de souvenir." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Nombre maximal de résultats (défaut 20)." },
    },
    read: (d, a) => {
      if (a.type !== undefined && !MEMORY_TYPES.includes(a.type as MemoryType)) throw new ArgError(`\`type\` doit être l'un de : ${MEMORY_TYPES.join(", ")}.`);
      return { items: d.memoryList(a.type as MemoryType | undefined, limitArg(a, 20, 100)).map(memoryItem) };
    },
  },
  {
    name: "sessions_list",
    description: "Liste les conversations récentes de Jarod (identifiant, titre, nombre de messages, date). Lecture seule.",
    properties: { limit: { type: "integer", minimum: 1, maximum: 50, description: "Nombre maximal de conversations (défaut 20)." } },
    read: (d, a) => ({ items: d.sessionsList(limitArg(a, 20, 50)).map(sessionItem) }),
  },
  {
    name: "sessions_search",
    description: "Recherche plein texte dans l'historique des conversations de Jarod (titres et messages) ; rend des extraits. Lecture seule.",
    properties: {
      query: { type: "string", description: "Mots-clés à chercher." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Nombre maximal de résultats (défaut 20)." },
    },
    required: ["query"],
    read: (d, a) => ({
      items: d.sessionsSearch(queryArg(a), limitArg(a, 20, 50)).map((h) => ({
        id: h.sessionId,
        title: cut(clean(h.title), MAX_TITLE_CHARS),
        snippet: cut(clean(h.snippet), 500),
        at: iso(h.updatedAt),
      })),
    }),
  },
  {
    name: "session_get",
    description:
      "Rend les messages d'une conversation de Jarod : seulement les textes de l'utilisateur et de l'assistant (jamais les sorties d'outils, la réflexion du modèle ni les pièces jointes). Pagination : `before` = indice `n` du premier message déjà reçu. Lecture seule.",
    properties: {
      id: { type: "string", description: "Identifiant de la conversation (voir sessions_list)." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Nombre maximal de messages (défaut 50)." },
      before: { type: "integer", minimum: 0, description: "Ne rendre que les messages d'indice n inférieur à cette valeur." },
    },
    required: ["id"],
    read: (d, a) => {
      if (typeof a.id !== "string" || !a.id) throw new ArgError("`id` est obligatoire.");
      const limit = limitArg(a, 50, 100);
      if (a.before !== undefined && (typeof a.before !== "number" || !Number.isInteger(a.before) || a.before < 0))
        throw new ArgError("`before` doit être un entier d'au moins 0.");
      const s = d.sessionGet(a.id);
      if (!s) throw new ArgError("Conversation introuvable.");
      const all = exposedMessages(d.messages(s.id));
      const end = Math.min((a.before as number | undefined) ?? all.length, all.length);
      const start = Math.max(0, end - limit);
      const page = all.slice(start, end).map((m, i) => ({
        n: start + i,
        role: m.role as "user" | "assistant",
        text: cut(clean(m.content), MAX_MESSAGE_CHARS),
        at: iso(m.createdAt),
      }));
      return {
        session: { id: s.id, title: cut(clean(s.title), MAX_TITLE_CHARS), messages: all.length },
        messages: page,
        ...(start > 0 ? { nextBefore: start } : {}),
      };
    },
  },
];

export const MCP_TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

/** Réduit la réponse sous la borne : listes de résultats = on retire la fin (les moins pertinents) ; messages = on retire les plus anciens. */
function fit(result: Record<string, unknown>): string {
  let text = JSON.stringify(result);
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  const key = Array.isArray(result.items) ? "items" : Array.isArray(result.messages) ? "messages" : null;
  if (!key) return text.slice(0, MAX_RESPONSE_CHARS);
  const list = [...(result[key] as { n?: number }[])];
  const oldestFirst = key === "messages";
  const out: Record<string, unknown> = { ...result, truncated: true };
  while (list.length > 1) {
    if (oldestFirst) list.shift();
    else list.pop();
    out[key] = list;
    if (oldestFirst && typeof list[0]?.n === "number" && list[0].n > 0) out.nextBefore = list[0].n;
    text = JSON.stringify(out);
    if (text.length <= MAX_RESPONSE_CHARS) return text;
  }
  return text.slice(0, MAX_RESPONSE_CHARS);
}

export interface McpHandlers {
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
}

export function createMcpServerHandlers(opts: { data: McpData; version: string; audit?: (e: McpAuditEntry) => void }): McpHandlers {
  let initialized = false;
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  const listTools = () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: "object", properties: t.properties, ...(t.required ? { required: t.required } : {}), additionalProperties: false },
      annotations: { title: t.name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  });

  function callTool(params: unknown): { content: { type: "text"; text: string }[]; isError?: true } {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const tool = typeof p.name === "string" ? byName.get(p.name) : undefined;
    if (!tool) throw new RpcError(ERR.invalidParams, `Outil inconnu : ${typeof p.name === "string" ? cut(p.name, 80) : "(sans nom)"}`);
    const argBytes = Buffer.byteLength(JSON.stringify(p.arguments ?? {}));
    let text: string;
    let ok = true;
    try {
      const args = p.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ArgError("Les arguments doivent être un objet.");
      text = fit(tool.read(opts.data, args as Record<string, unknown>) as Record<string, unknown>);
    } catch (e) {
      ok = false;
      if (e instanceof ArgError) text = e.message;
      else {
        process.stderr.write(`[mcp] ${tool.name} : lecture impossible (${(e as Error).name})\n`);
        text = "Lecture impossible (erreur interne du serveur).";
      }
    }
    opts.audit?.({ tool: tool.name, argBytes, resultBytes: Buffer.byteLength(text), ok });
    return { content: [{ type: "text", text }], ...(ok ? {} : { isError: true as const }) };
  }

  return {
    async onRequest(method, params) {
      if (method === "ping") return {};
      if (method === "initialize") {
        const asked = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
        initialized = true;
        return {
          protocolVersion: (SUPPORTED_PROTOCOLS as readonly unknown[]).includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "jarod", version: opts.version },
          instructions:
            "Jarod : mémoire et historique de conversations de l'utilisateur, en LECTURE SEULE (aucune écriture, aucun envoi). Commencez par memory_search ou sessions_search.",
        };
      }
      if (method === "tools/list" || method === "tools/call") {
        if (!initialized) throw new RpcError(ERR.invalidRequest, "Serveur non initialisé : envoyez d'abord `initialize`.");
        return method === "tools/list" ? listTools() : callTool(params);
      }
      throw new RpcError(ERR.methodNotFound, `Méthode inconnue : ${cut(method, 80)}`);
    },
    onNotification() {
      /* notifications/initialized, notifications/cancelled : rien à faire (lecture synchrone et courte). */
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Journal d'audit, boucle. (Le contrôle de schéma partagé avec `acp` est dans preflight.ts.)

export type { Preflight };
export const mcpPreflight = (o: Parameters<typeof profilePreflight>[0]): Preflight => profilePreflight({ ...o, command: o.command ?? "jarod mcp" });

const AUDIT_ROTATE_BYTES = 1024 * 1024;

/** Journal d'audit : une ligne par appel, JAMAIS de contenu. Un fichier de plus d'1 Mo passe en `.1` (un seul ancien gardé). */
export function fileAudit(path: string): (e: McpAuditEntry) => void {
  return (e) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && statSync(path).size > AUDIT_ROTATE_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, `${new Date().toISOString()} ${e.tool} args=${e.argBytes}o résultat=${e.resultBytes}o ${e.ok ? "ok" : "erreur"}\n`);
    } catch {
      /* un journal qui échoue ne doit jamais faire échouer une lecture */
    }
  };
}

export function dataFromCore(core: Awaited<ReturnType<typeof openCore>>["core"]): McpData {
  return {
    memorySearch: (q, limit) => core.memory.search(q, limit),
    memoryList: (type, limit) => core.memory.list(type).slice(0, limit),
    sessionsList: (limit) => core.sessions.list(limit),
    sessionsSearch: (q, limit) => core.sessions.search(q, limit),
    sessionGet: (id) => core.sessions.get(id),
    messages: (id) => core.messages.list(id),
  };
}

export interface McpCommandOptions {
  dataRoot: string;
  version: string;
  profile?: string;
  input?: NodeJS.ReadableStream & { destroy(): unknown };
  output?: NodeJS.WritableStream;
  keyStores?: KeyStore[];
  env?: NodeJS.ProcessEnv;
}

export async function mcpCommand(o: McpCommandOptions): Promise<number> {
  const pre = mcpPreflight({ dataRoot: o.dataRoot, ...(o.profile ? { profile: o.profile } : {}), ...(o.keyStores ? { keyStores: o.keyStores } : {}) });
  if (!pre.ok) {
    process.stderr.write(`jarod mcp : ${pre.message}\n`);
    return 1;
  }
  const { core, dispose } = await (async () => {
    const c = await openCore({ profile: pre.profile, env: o.env ?? { ...process.env, JAROD_HOME: o.dataRoot } });
    return { core: c.core, dispose: () => c.core.dispose() };
  })();
  const input = (o.input ?? process.stdin) as NodeJS.ReadableStream & { destroy(): unknown };
  const output = o.output ?? process.stdout;
  // G1 : la ligne de démarrage va sur stderr (journal du client), jamais sur stdout.
  process.stderr.write(`jarod mcp (pid ${process.pid}) : profil « ${pre.profile} », lecture seule, outils : ${MCP_TOOL_NAMES.join(", ")}. Démarré sur ordre de l'utilisateur ; ce client voit la mémoire et l'historique du profil.\n`);
  const handlers = createMcpServerHandlers({ data: dataFromCore(core), version: o.version, audit: fileAudit(join(o.dataRoot, "mcp-server.log")) });
  const server = serveJsonRpc({
    input: input as never,
    output: output as never,
    onRequest: handlers.onRequest,
    onNotification: handlers.onNotification,
  });
  const stop = (): void => {
    input.destroy();
  };
  if (!o.input) {
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  await server.closed;
  if (!o.input) {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
  await dispose();
  return 0;
}
