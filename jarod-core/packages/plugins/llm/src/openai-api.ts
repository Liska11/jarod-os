// Portage de packages/core/src/services/openai-api.ts (rév. 2e180305).
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Emitter } from "@jarod/kernel/util";
import { type ApiServerConfig } from "@jarod/contracts";
export type { ApiServerConfig };

/**
 * Jarod behind an OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`), so that any client
 * that speaks it — Open WebUI, an editor plugin, a script — talks to the agent with its tools,
 * memory and skills, not to a bare model.
 *
 * Such clients are stateless: they send the whole history with every request. Jarod is not: each
 * conversation is a session with its own context. The two meet through a fingerprint of the history
 * already exchanged — after each answer, the fingerprint of (history + answer) is remembered, and
 * the next request whose history matches it continues the same session. A history Jarod never saw
 * starts a new session, with that history given as context.
 *
 * Every request needs the API key (Bearer). The server listens on 127.0.0.1 unless the user opens
 * it to the local network, and reads at most 2 MB per request.
 */

// ApiServerConfig : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

export const DEFAULT_API_SERVER: ApiServerConfig = { enabled: false, port: 8642, host: "127.0.0.1" };
export const API_KEY_SECRET = "api:openai:key";
export const API_MODEL = "jarod";
const MAX_BODY = 2 * 1024 * 1024;

export interface ApiMessage {
  role: string;
  content: unknown;
}

/** The text of an OpenAI message content: a string, or the text parts of an array. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && (p as { type?: string }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Fingerprint of a conversation: roles and texts of its user and assistant turns, in order. */
export function conversationKey(messages: ApiMessage[]): string {
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => [m.role, textOf(m.content).trim()]);
  return createHash("sha256").update(JSON.stringify(turns)).digest("hex").slice(0, 32);
}

export interface ApiRun {
  /** The session to continue, or null for a new one. */
  sessionId: string | null;
  prompt: string;
  /** Title of a new session. */
  title: string;
  onDelta: (text: string) => void;
  signal: AbortSignal;
}

export interface ApiServerStatus {
  running: boolean;
  port: number | null;
  error?: string;
}

export class OpenAIApiServer extends Emitter<{ status: ApiServerStatus }> {
  private server: Server | null = null;
  status: ApiServerStatus = { running: false, port: null };

  constructor(
    private readonly d: {
      config: () => ApiServerConfig;
      key: () => string;
      run: (r: ApiRun) => Promise<{ sessionId: string; text: string; error?: string }>;
      /** Session continued by a conversation fingerprint (kept by the core). */
      lookup: (key: string) => string | null;
      remember: (key: string, sessionId: string) => void;
    },
  ) {
    super();
  }

  private setStatus(s: ApiServerStatus): void {
    this.status = s;
    this.emit("status", s);
  }

  async start(): Promise<void> {
    this.stop();
    const cfg = this.d.config();
    const server = createServer((req, res) => void this.route(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1", () => resolve());
      });
    } catch (e) {
      this.setStatus({ running: false, port: null, error: `Port ${cfg.port} indisponible : ${(e as Error).message}` });
      return;
    }
    this.server = server;
    const address = server.address();
    this.setStatus({ running: true, port: typeof address === "object" && address ? address.port : cfg.port });
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    if (this.status.running) this.setStatus({ running: false, port: null });
  }

  private authorized(req: IncomingMessage): boolean {
    const header = String(req.headers.authorization ?? "");
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const key = Buffer.from(this.d.key());
    return key.length > 0 && given.length === key.length && timingSafeEqual(given, key);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const fail = (status: number, message: string, code: string) =>
      json(status, { error: { message, type: "invalid_request_error", code } });
    const path = new URL(req.url ?? "/", "http://x").pathname.replace(/\/+$/, "");
    if (!this.authorized(req)) return fail(401, "Clé d'API manquante ou invalide.", "invalid_api_key");

    if (req.method === "GET" && path === "/v1/models") {
      return json(200, {
        object: "list",
        data: [{ id: API_MODEL, object: "model", created: 0, owned_by: "jarod-one" }],
      });
    }
    if (req.method !== "POST" || path !== "/v1/chat/completions") return fail(404, "Route inconnue.", "not_found");

    const raw = await readBody(req, MAX_BODY);
    if (raw === null) return fail(413, "Requête trop volumineuse.", "payload_too_large");
    let body: { messages?: ApiMessage[]; stream?: boolean };
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "JSON illisible.", "invalid_json");
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    if (last?.role !== "user" || !textOf(last.content).trim()) {
      return fail(400, "Le dernier message doit venir de l'utilisateur.", "invalid_messages");
    }
    const history = messages.slice(0, -1);
    const sessionId = this.d.lookup(conversationKey(history));
    let prompt = textOf(last.content);
    if (!sessionId) {
      const context = history
        .filter((m) => ["system", "user", "assistant"].includes(m.role) && textOf(m.content).trim())
        .map(
          (m) =>
            `${m.role === "system" ? "Consignes du client" : m.role === "user" ? "Utilisateur" : "Assistant"} : ${textOf(m.content)}`,
        );
      if (context.length) {
        prompt = `Échanges précédents, transmis par le client :\n${context.join("\n\n")}\n\nNouveau message :\n${prompt}`;
      }
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    let sent = "";
    const stream = body.stream === true;
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: API_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(chunk({ role: "assistant" }));
    }
    const result = await this.d.run({
      sessionId,
      prompt,
      title: textOf(last.content).replace(/\s+/g, " ").slice(0, 50),
      signal: controller.signal,
      onDelta: (text) => {
        if (!stream) return;
        sent += text;
        res.write(chunk({ content: text }));
      },
    });
    const answer = result.error ? `Erreur : ${result.error}` : result.text;
    if (stream) {
      // What was not streamed (a final answer given without deltas, or an error) is sent now.
      if (!sent) {
        sent = answer;
        res.write(chunk({ content: answer }));
      }
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    } else {
      sent = answer;
      json(200, {
        id,
        object: "chat.completion",
        created,
        model: API_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    if (!result.error) {
      this.d.remember(conversationKey([...messages, { role: "assistant", content: sent }]), result.sessionId);
    }
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(size > max ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}
