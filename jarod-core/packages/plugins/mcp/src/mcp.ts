// Portage de packages/core/src/services/mcp.ts (rév. 2e180305).
import { type ChildProcess, spawn } from "node:child_process";
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

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  state: "stopped" | "starting" | "running" | "error";
  error?: string;
  tools: string[];
}

/** Starts configured MCP servers and exposes their tools to the agent as `mcp_<server>_<tool>`. */
export class McpManager extends Emitter<{ changed: McpServerStatus[] }> {
  private clients = new Map<string, McpConnection>();
  private status = new Map<string, McpServerStatus>();

  constructor(private readonly tools: ToolRegistry) {
    super();
  }

  list(): McpServerStatus[] {
    return [...this.status.values()];
  }

  async sync(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Set(configs.filter((c) => c.enabled).map((c) => c.id));
    for (const id of [...this.clients.keys()]) if (!wanted.has(id)) this.stopOne(id);
    for (const id of [...this.status.keys()]) if (!configs.some((c) => c.id === id)) this.status.delete(id);
    for (const c of configs) {
      if (!c.enabled) this.status.set(c.id, { id: c.id, name: c.name, enabled: false, state: "stopped", tools: [] });
    }
    this.emit("changed", this.list());
    await Promise.all(configs.filter((c) => c.enabled && !this.clients.has(c.id)).map((c) => this.startOne(c)));
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
    const st: McpServerStatus = { id: cfg.id, name: cfg.name, enabled: true, state: "starting", tools: [] };
    this.status.set(cfg.id, st);
    this.emit("changed", this.list());
    const client: McpConnection = cfg.url ? new McpHttpClient(cfg.url, cfg.headers ?? {}) : new McpClient(cfg);
    this.clients.set(cfg.id, client);
    try {
      await client.start();
      const tools = await client.listTools();
      const prefix = toolName(`mcp_${cfg.name}`).slice(0, 24);
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
        this.tools.register(def);
        st.tools.push(def.name);
      }
      st.state = "running";
    } catch (e) {
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
    if (st) Object.assign(st, { state: "stopped", tools: [] });
  }

  stopAll(): void {
    for (const id of [...this.clients.keys()]) this.stopOne(id);
  }
}
