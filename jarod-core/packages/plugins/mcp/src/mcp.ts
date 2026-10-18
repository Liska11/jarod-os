// Portage de packages/core/src/services/mcp.ts (rév. 2e180305).
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ToolDef, ToolRegistry } from "@jarod/plugin-tools";
import { toolName } from "@jarod/plugin-tools";
import { Emitter, killTree, parseJson, SseParser, truncate } from "@jarod/kernel/util";
import type { McpServerConfig } from "@jarod/plugin-storage";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = "2025-06-18";

/** What the manager needs from a connection to an MCP server, whatever the transport. */
export interface McpConnection {
  serverInfo: { name?: string; version?: string };
  start(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  stop(): void;
}

type CallResult = {
  content?: { type: string; text?: string; mimeType?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
};

function formatCallResult(res: CallResult): { text: string; isError: boolean } {
  const parts = (res.content ?? []).map((c) =>
    c.type === "text" ? (c.text ?? "") : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`,
  );
  if (parts.length === 0 && res.structuredContent !== undefined)
    parts.push(JSON.stringify(res.structuredContent, null, 2));
  return { text: truncate(parts.join("\n"), 30_000), isError: Boolean(res.isError) };
}

async function listAllTools(request: (method: string, params: unknown) => Promise<unknown>): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const res = (await request("tools/list", cursor ? { cursor } : {})) as { tools: McpTool[]; nextCursor?: string };
    tools.push(...(res.tools ?? []));
    cursor = res.nextCursor;
  } while (cursor);
  return tools;
}

/**
 * L'échappement d'un argument pour `cmd.exe` (Windows, `shell: true`).
 *
 * Phase 4 (audit v4) : l'ancien code échappait un guillemet littéral par `\"`. `cmd.exe` n'attribue AUCUN
 * sens particulier à l'antislash : à l'intérieur d'une chaîne entre guillemets, un guillemet s'écrit `""`.
 * Avec `\"`, la chaîne se refermait au premier guillemet et la suite était interprétée comme des commandes
 * (`&`, `|`, `>` suffisaient à en lancer une autre).
 */
export function cmdQuote(a: string): string {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

/** Model Context Protocol client over stdio (newline-delimited JSON-RPC 2.0). */
export class McpClient implements McpConnection {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  stderr = "";
  serverInfo: { name?: string; version?: string } = {};

  constructor(
    readonly config: Pick<McpServerConfig, "command" | "args" | "env">,
    private readonly timeoutMs = 30_000,
  ) {}

  async start(): Promise<void> {
    const { command, args } = this.config;
    // npx/uvx are .cmd shims on Windows and need a shell to resolve; real executables don't.
    const useShell = process.platform === "win32" && !isAbsolute(command) && !/\.exe$/i.test(command);
    const quote = cmdQuote;
    const proc = spawn(useShell ? quote(command) : command, useShell ? args.map(quote) : args, {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr!.on("data", (b: Buffer) => {
      this.stderr = (this.stderr + b.toString("utf8")).slice(-4000);
    });
    proc.on("exit", (code) => this.failAll(new Error(`Serveur MCP arrêté (code ${code}). ${this.stderr.slice(-500)}`)));
    proc.on("error", (e) => this.failAll(e));

    const init = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jarod-one", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = init.serverInfo ?? {};
    this.notify("notifications/initialized", {});
  }

  listTools(): Promise<McpTool[]> {
    return listAllTools((m, p) => this.request(m, p));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    return formatCallResult((await this.request("tools/call", { name, arguments: args })) as CallResult);
  }

  stop(): void {
    this.failAll(new Error("Serveur MCP arrêté"));
    // npx/uvx run under a shell on Windows: kill the whole tree, not just the shell.
    if (this.proc) killTree(this.proc);
    this.proc = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error("Serveur MCP non démarré"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Délai dépassé pour ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout; ignore non-JSON lines
      }
      if (msg.id == null || msg.method) {
        // Server-initiated request (e.g. ping): reply so the server does not stall.
        if (msg.id != null && msg.method === "ping") {
          this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
        }
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

type JsonRpcMessage = { id?: number | string; method?: string; result?: unknown; error?: { message: string } };

/**
 * Model Context Protocol client over Streamable HTTP: JSON-RPC requests are POSTed to one URL and
 * answered with JSON or an SSE stream. Static headers carry authentication (e.g. a bearer token).
 */
export class McpHttpClient implements McpConnection {
  private nextId = 1;
  private sessionId: string | null = null;
  private protocol: string | null = null;
  serverInfo: { name?: string; version?: string } = {};

  constructor(
    readonly url: string,
    private readonly extraHeaders: Record<string, string> = {},
    private readonly timeoutMs = 60_000,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.extraHeaders,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {}),
    };
  }

  async start(): Promise<void> {
    const init = (await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "jarod-one", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string };
    this.serverInfo = init.serverInfo ?? {};
    this.protocol = init.protocolVersion ?? PROTOCOL_VERSION;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => {});
  }

  listTools(): Promise<McpTool[]> {
    return listAllTools((m, p) => this.request(m, p));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    return formatCallResult((await this.request("tools/call", { name, arguments: args })) as CallResult);
  }

  stop(): void {
    // Ends the server-side session (best effort).
    if (this.sessionId)
      void fetch(this.url, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(
        () => {},
      );
    this.sessionId = null;
  }

  private async post(body: unknown): Promise<Response> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => "");
      const hint = res.status === 401 ? " (authentification requise : ajoutez un en-tête Authorization)" : "";
      throw new Error(`HTTP ${res.status}${hint} ${text.slice(0, 300)}`);
    }
    return res;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const type = res.headers.get("content-type") ?? "";
    let reply: JsonRpcMessage | undefined;
    if (type.includes("text/event-stream") && res.body) {
      const parser = new SseParser((_event, data) => {
        const msg = parseJson<JsonRpcMessage | null>(data, null);
        if (msg && msg.id === id && !msg.method) reply = msg;
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (!reply) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.flush();
      await reader.cancel().catch(() => {});
    } else {
      const body = parseJson<JsonRpcMessage | JsonRpcMessage[] | null>(await res.text(), null);
      reply = Array.isArray(body) ? body.find((m) => m.id === id) : (body ?? undefined);
    }
    if (!reply) throw new Error(`Réponse MCP manquante pour ${method}`);
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  }
}

/** Un outil retenu parce que sa description (ou son schéma) ne correspond plus à ce que l'utilisateur a accepté. */
export interface McpPendingTool {
  tool: string;
  reason: "changed" | "new";
  /** Empreinte acceptée (absente pour un outil nouveau). */
  pinned?: string;
  current: string;
}

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  state: "stopped" | "starting" | "running" | "error";
  error?: string;
  tools: string[];
  /** Outils non enregistrés en attendant un nouvel accord (`McpManager.approve`). */
  pending: McpPendingTool[];
}

/** Événement du journal : jamais le texte d'une description, seulement des noms et des empreintes. */
export interface McpAuditEvent {
  kind: "pinned" | "changed" | "new" | "approved";
  server: string;
  tool?: string;
  pinned?: string;
  current?: string;
  count?: number;
}

/** Empreintes acceptées par serveur : `{ outil: sha256 }`. */
export interface McpPinStore {
  get(serverId: string): Record<string, string> | undefined;
  set(serverId: string, pins: Record<string, string>): void;
}

export class MemoryPinStore implements McpPinStore {
  private readonly data = new Map<string, Record<string, string>>();
  get(serverId: string) {
    const v = this.data.get(serverId);
    return v ? { ...v } : undefined;
  }
  set(serverId: string, pins: Record<string, string>) {
    this.data.set(serverId, { ...pins });
  }
}

type PinDb = {
  all<T>(sql: string, ...p: (string | number | null)[]): T[];
  run(sql: string, ...p: (string | number | null)[]): unknown;
  exec(sql: string): void;
};

/** Persistance des épingles dans le profil (table dédiée, aucune valeur secrète). */
export class SqlPinStore implements McpPinStore {
  constructor(private readonly db: PinDb) {
    db.exec("CREATE TABLE IF NOT EXISTS mcp_tool_pins (server_id TEXT NOT NULL, tool TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY (server_id, tool))");
  }
  get(serverId: string) {
    const rows = this.db.all<{ tool: string; fingerprint: string }>("SELECT tool, fingerprint FROM mcp_tool_pins WHERE server_id = ?", serverId);
    return rows.length ? Object.fromEntries(rows.map((r) => [r.tool, r.fingerprint])) : undefined;
  }
  set(serverId: string, pins: Record<string, string>) {
    this.db.run("DELETE FROM mcp_tool_pins WHERE server_id = ?", serverId);
    for (const [tool, fp] of Object.entries(pins)) this.db.run("INSERT INTO mcp_tool_pins (server_id, tool, fingerprint) VALUES (?, ?, ?)", serverId, tool, fp);
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}

/** SHA-256 de ce que le modèle lit de l'outil : nom, description, schéma (clés triées). */
export function fingerprintTool(t: McpTool): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {} })))
    .digest("hex");
}

export interface McpManagerOptions {
  pins?: McpPinStore;
  audit?: (event: McpAuditEvent) => void;
  /** Échecs de démarrage consécutifs avant que le serveur soit désactivé (défaut 3). */
  maxFailures?: number;
}

/** Ce que l'utilisateur voit AVANT d'activer un serveur : ses outils, leur empreinte, et l'état par rapport à l'accord. */
export interface McpPreviewTool {
  name: string;
  fingerprint: string;
  /** Description nettoyée et tronquée : c'est du texte écrit par un tiers, jamais une consigne. */
  description: string;
  pinState: "approved" | "changed" | "new" | "unknown";
  dangerous: true;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: intended, strips control characters from untrusted text
const stripControl = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");

/** Starts configured MCP servers and exposes their tools to the agent as `mcp_<server>_<tool>`. */
export class McpManager extends Emitter<{ changed: McpServerStatus[] }> {
  private clients = new Map<string, McpConnection>();
  private status = new Map<string, McpServerStatus>();
  private readonly pins: McpPinStore;
  private readonly audit: (event: McpAuditEvent) => void;
  /** Outils retenus : leur définition complète attend `approve`. */
  private held = new Map<string, Map<string, { def: ToolDef; fingerprint: string }>>();
  private readonly maxFailures: number;
  private failures = new Map<string, number>();

  constructor(
    private readonly tools: ToolRegistry,
    options: McpManagerOptions = {},
  ) {
    super();
    this.pins = options.pins ?? new MemoryPinStore();
    this.audit = options.audit ?? (() => {});
    this.maxFailures = Math.max(1, options.maxFailures ?? 3);
  }

  /** Remet le compteur d'échecs à zéro : un serveur désactivé après des échecs ne redémarre qu'après ce geste explicite. */
  resetFailures(serverId: string): void {
    this.failures.delete(serverId);
  }

  /**
   * Connexion TEMPORAIRE : liste les outils avec leur empreinte et leur état par rapport aux épingles, sans rien
   * enregistrer ni épingler. Sert à montrer outils et permissions avant l'activation (tous les outils MCP demandent un accord).
   */
  async preview(cfg: McpServerConfig): Promise<McpPreviewTool[]> {
    const pinned = this.pins.get(cfg.id);
    return (await this.probe(cfg)).map((t) => {
      const fingerprint = fingerprintTool(t);
      const accepted = pinned?.[t.name];
      const pinState: McpPreviewTool["pinState"] = !pinned ? "unknown" : accepted === undefined ? "new" : accepted === fingerprint ? "approved" : "changed";
      return { name: t.name, fingerprint, description: stripControl(t.description ?? "").slice(0, 300), pinState, dangerous: true as const };
    });
  }

  /**
   * Accepte la description actuelle d'un outil retenu : la nouvelle empreinte est épinglée, l'outil est enregistré,
   * l'accord est journalisé. Sans appel, l'outil reste absent (échec fermé).
   */
  approve(serverId: string, tool: string): void {
    const entry = this.held.get(serverId)?.get(tool);
    const st = this.status.get(serverId);
    if (!entry || !st) throw new Error(`MCP ${serverId} : aucune divergence en attente pour l'outil ${tool}`);
    this.pins.set(serverId, { ...(this.pins.get(serverId) ?? {}), [tool]: entry.fingerprint });
    this.tools.register(entry.def);
    st.tools.push(entry.def.name);
    st.pending = st.pending.filter((p) => p.tool !== tool);
    this.held.get(serverId)!.delete(tool);
    this.audit({ kind: "approved", server: serverId, tool, current: entry.fingerprint });
    this.emit("changed", this.list());
  }

  list(): McpServerStatus[] {
    return [...this.status.values()];
  }

  async sync(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Set(configs.filter((c) => c.enabled).map((c) => c.id));
    for (const id of [...this.clients.keys()]) if (!wanted.has(id)) this.stopOne(id);
    for (const id of [...this.status.keys()]) if (!configs.some((c) => c.id === id)) this.status.delete(id);
    for (const c of configs) {
      if (!c.enabled) this.status.set(c.id, { id: c.id, name: c.name, enabled: false, state: "stopped", tools: [], pending: [] });
    }
    this.emit("changed", this.list());
    await Promise.all(
      configs
        .filter((c) => c.enabled && !this.clients.has(c.id))
        .map((c) => {
          if ((this.failures.get(c.id) ?? 0) >= this.maxFailures) {
            this.status.set(c.id, { id: c.id, name: c.name, enabled: false, state: "error", error: `désactivé après ${this.maxFailures} échecs de démarrage`, tools: [], pending: [] });
            this.emit("changed", this.list());
            return Promise.resolve();
          }
          return this.startOne(c);
        }),
    );
  }

  async restart(config: McpServerConfig): Promise<void> {
    this.stopOne(config.id);
    if (config.enabled) await this.startOne(config);
  }

  /**
   * Jarod-cordis (D1(b) `test-mcp-server`, équivalent de `hermes mcp test`) : connexion TEMPORAIRE au serveur
   * décrit, liste de ses outils, puis arrêt. Rien n'est enregistré au registre ni dans l'état du gestionnaire.
   */
  async probe(cfg: McpServerConfig): Promise<McpTool[]> {
    const client: McpConnection = cfg.url ? new McpHttpClient(cfg.url, cfg.headers ?? {}) : new McpClient(cfg);
    try {
      await client.start();
      return await client.listTools();
    } finally {
      client.stop();
    }
  }

  private async startOne(cfg: McpServerConfig): Promise<void> {
    const st: McpServerStatus = { id: cfg.id, name: cfg.name, enabled: true, state: "starting", tools: [], pending: [] };
    this.held.delete(cfg.id);
    this.status.set(cfg.id, st);
    this.emit("changed", this.list());
    const client: McpConnection = cfg.url ? new McpHttpClient(cfg.url, cfg.headers ?? {}) : new McpClient(cfg);
    this.clients.set(cfg.id, client);
    try {
      await client.start();
      const tools = await client.listTools();
      const prefix = toolName(`mcp_${cfg.name}`).slice(0, 24);
      const pinned = this.pins.get(cfg.id);
      if (!pinned) {
        // Première connexion : activer le serveur est l'accord de l'utilisateur ; l'état vu est épinglé.
        this.pins.set(cfg.id, Object.fromEntries(tools.map((t) => [t.name, fingerprintTool(t)])));
        this.audit({ kind: "pinned", server: cfg.id, count: tools.length });
      }
      for (const t of tools) {
        const def: ToolDef = {
          name: toolName(`${prefix}_${t.name}`),
          description: `[MCP ${cfg.name}] ${t.description ?? t.name}`,
          parameters: t.inputSchema ?? { type: "object", properties: {} },
          // External servers can do anything; ask before each call unless auto-approve is on.
          dangerous: true,
          source: "mcp",
          run: async (args) => {
            const r = await client.callTool(t.name, args);
            if (r.isError) throw new Error(r.text || "Erreur de l'outil MCP");
            return r.text;
          },
        };
        (def as ToolDef & { mcpServer: string }).mcpServer = cfg.id;
        const current = fingerprintTool(t);
        const accepted = pinned?.[t.name];
        if (pinned && accepted !== current) {
          const reason = accepted === undefined ? "new" : "changed";
          this.held.set(cfg.id, (this.held.get(cfg.id) ?? new Map()).set(t.name, { def, fingerprint: current }));
          st.pending.push({ tool: t.name, reason, ...(accepted ? { pinned: accepted } : {}), current });
          this.audit({ kind: reason, server: cfg.id, tool: t.name, ...(accepted ? { pinned: accepted } : {}), current });
          continue;
        }
        this.tools.register(def);
        st.tools.push(def.name);
      }
      st.state = "running";
      this.failures.delete(cfg.id);
    } catch (e) {
      this.failures.set(cfg.id, (this.failures.get(cfg.id) ?? 0) + 1);
      st.state = "error";
      st.error = (e as Error).message;
      client.stop();
      this.clients.delete(cfg.id);
    }
    this.emit("changed", this.list());
  }

  private stopOne(id: string): void {
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    this.tools.unregisterWhere((t) => (t as ToolDef & { mcpServer?: string }).mcpServer === id);
    const st = this.status.get(id);
    if (st) Object.assign(st, { state: "stopped", tools: [], pending: [] });
    this.held.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.clients.keys()]) this.stopOne(id);
  }
}
