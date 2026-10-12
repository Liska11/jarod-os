// Portage de packages/core/src/services/whatsapp.ts (rév. 2e180305).
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname } from "node:path";
import { Emitter } from "@jarod/kernel/util";
import { downloadFile, type GatewayStatus, type IncomingFile, splitMessage } from "./telegram.js";
import { type WhatsAppConfig, WHATSAPP_TOKEN_KEY, WHATSAPP_APP_SECRET_KEY } from "@jarod/contracts";
export { WHATSAPP_TOKEN_KEY, WHATSAPP_APP_SECRET_KEY };
export type { WhatsAppConfig };

/**
 * WhatsApp through Meta's official Cloud API — and nothing else: unofficial clients that drive
 * WhatsApp Web get numbers banned, and they hold the user's whole account.
 *
 * Meta pushes incoming messages to a webhook, so this gateway listens on 127.0.0.1 only (a tunnel
 * chosen by the user — cloudflared, Tailscale Funnel, a reverse proxy — gives it its public HTTPS
 * address). What protects the door is not the address but the signature: every POST must carry
 * `X-Hub-Signature-256`, an HMAC of the body with the app secret, compared in constant time.
 * Anything unsigned is refused before being parsed.
 *
 * Answers go through the Graph API with a (system user) access token. WhatsApp only allows free
 * text within 24 h of the contact's last message; past that, a scheduled delivery fails with an
 * explanation instead of a raw error code.
 */

// WhatsAppConfig : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// WHATSAPP_APP_SECRET_KEY : déplacé dans @jarod/contracts (ré-exporté ci-dessous).
export const WHATSAPP_VERIFY_TOKEN_KEY = "gateway:whatsapp:verify-token";
export const WHATSAPP_GRAPH_VERSION = "v23.0";
export const DEFAULT_WHATSAPP_PORT = 8791;

export const DEFAULT_WHATSAPP_CONFIG: WhatsAppConfig = {
  enabled: false,
  phoneNumberId: "",
  port: DEFAULT_WHATSAPP_PORT,
  allowedNumbers: [],
};

/** Webhook bodies are small JSON documents: anything past this is not Meta. */
const MAX_BODY = 1024 * 1024;
/** WhatsApp caps a text message at 4096 characters. */
const MAX_TEXT = 4000;

/** A number as WhatsApp writes it (`wa_id`): digits only, no "+", no spaces. */
export const normalizeNumber = (n: string) => n.replace(/\D/g, "");

/** The local address Meta's webhook must eventually reach (through the user's tunnel). */
export const whatsappWebhookUrl = (port: number) => `http://127.0.0.1:${port}/whatsapp`;

/** True when `header` is `sha256=<hex>` of the HMAC-SHA256 of `raw` with `secret`. */
export function verifySignature(header: string, raw: Buffer, secret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m || !secret) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(Buffer.from(m[1]!, "hex"), expected);
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

/** The MIME type WhatsApp accepts for a document, or null when it refuses that kind of file. */
export function whatsappMime(name: string): string | null {
  const ext = extname(name).toLowerCase();
  const known: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
  };
  if (known[ext]) return known[ext]!;
  // Text files of any kind (code, CSV, Markdown…) travel as plain text documents.
  const text = [".txt", ".md", ".csv", ".json", ".log", ".yaml", ".yml", ".xml", ".html", ".ts", ".js", ".py"];
  return text.includes(ext) ? "text/plain" : null;
}

interface WaMedia {
  id: string;
  mime_type?: string;
  filename?: string;
  caption?: string;
}
interface WaMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  image?: WaMedia;
  document?: WaMedia;
  audio?: WaMedia;
  video?: WaMedia;
  sticker?: WaMedia;
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
}
interface WaChangeValue {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
}

export interface IncomingWhatsApp {
  from: string;
  name: string;
  text: string;
  files: IncomingFile[];
}

export type WhatsAppHandler = (msg: IncomingWhatsApp) => Promise<string>;

export class WhatsAppGateway extends Emitter<{ status: GatewayStatus }> {
  status: GatewayStatus = { id: "whatsapp", state: "stopped" };
  private server: Server | null = null;
  private boundPort = 0;
  /** Meta redelivers a webhook it thinks was lost: each message id is handled once. */
  private seen: string[] = [];
  /** One run at a time per contact, in the order the messages came. */
  private queues = new Map<string, Promise<void>>();
  private readonly apiBase: string;

  constructor(
    private readonly config: () => WhatsAppConfig,
    private readonly secrets: { token: string; appSecret: string; verifyToken: string },
    private readonly handler: WhatsAppHandler,
    private readonly opts: {
      apiBase?: string;
      unknown?: (from: string, name: string) => Promise<string> | string;
      /** Refused or unreadable webhook calls: kept in the log, not in the notifications. */
      onIgnored?: (why: string) => void;
    } = {},
  ) {
    super();
    this.apiBase = `${opts.apiBase ?? "https://graph.facebook.com"}/${WHATSAPP_GRAPH_VERSION}`;
  }

  /** The port actually listened on (useful when the setting is 0). */
  get port(): number {
    return this.boundPort;
  }

  /** Settled when every message received so far has been answered (tests, clean shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private setStatus(s: Omit<GatewayStatus, "id">): void {
    this.status = { id: "whatsapp", ...s };
    this.emit("status", this.status);
  }

  async start(): Promise<void> {
    this.stop();
    const cfg = this.config();
    const server = createServer((req, res) => void this.route(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // 127.0.0.1: the public side is the user's tunnel, never an open port on the machine.
        server.listen(cfg.port, "127.0.0.1", () => resolve());
      });
    } catch (e) {
      this.setStatus({ state: "error", error: `Port ${cfg.port} indisponible : ${(e as Error).message}` });
      return;
    }
    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : cfg.port;
    try {
      const me = await this.graph<{ display_phone_number?: string; verified_name?: string }>(
        "GET",
        `${cfg.phoneNumberId}?fields=display_phone_number,verified_name`,
      );
      this.setStatus({ state: "running", botName: me.verified_name || me.display_phone_number || cfg.phoneNumberId });
    } catch (e) {
      // The webhook keeps listening: a token fixed in the settings restarts the gateway anyway.
      this.setStatus({ state: "error", error: (e as Error).message });
    }
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    if (this.status.state !== "stopped") this.setStatus({ state: "stopped" });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, body = "") => {
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(body);
    };
    if (url.pathname !== "/whatsapp") return reply(404);
    if (req.method === "GET") {
      // Meta's one-time check when the webhook is saved: echo the challenge if the token matches.
      const q = url.searchParams;
      if (q.get("hub.mode") === "subscribe" && sameSecret(q.get("hub.verify_token") ?? "", this.secrets.verifyToken)) {
        return reply(200, q.get("hub.challenge") ?? "");
      }
      this.opts.onIgnored?.("vérification refusée (jeton de vérification différent)");
      return reply(403);
    }
    if (req.method !== "POST") return reply(405);
    const raw = await readLimited(req, MAX_BODY);
    if (!raw) {
      this.opts.onIgnored?.("corps trop grand ou illisible");
      return reply(413);
    }
    if (!verifySignature(String(req.headers["x-hub-signature-256"] ?? ""), raw, this.secrets.appSecret)) {
      this.opts.onIgnored?.("signature X-Hub-Signature-256 absente ou invalide");
      return reply(401);
    }
    let body: { entry?: { changes?: { value?: WaChangeValue }[] }[] };
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(400);
    }
    // Answer Meta at once: it retries (and eventually disables the webhook) when a call is slow.
    reply(200);
    for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) this.receive(change.value ?? {});
  }

  /** Queues each new message of a webhook call behind the previous ones of the same contact. */
  receive(value: WaChangeValue): void {
    const own = this.config().phoneNumberId;
    // One Meta app can serve several numbers: only this number's messages are ours.
    if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== own) return;
    for (const msg of value.messages ?? []) {
      if (!msg.id || !msg.from || this.seen.includes(msg.id)) continue;
      this.seen.push(msg.id);
      if (this.seen.length > 500) this.seen = this.seen.slice(-500);
      const name = value.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name || `+${msg.from}`;
      const previous = this.queues.get(msg.from) ?? Promise.resolve();
      const next = previous
        .then(() => this.handle(msg, name))
        .catch((e) => this.opts.onIgnored?.(`réponse à +${msg.from} impossible : ${(e as Error).message}`));
      this.queues.set(msg.from, next);
      void next.finally(() => {
        if (this.queues.get(msg.from) === next) this.queues.delete(msg.from);
      });
    }
  }

  private async handle(msg: WaMessage, name: string): Promise<void> {
    const from = msg.from;
    // Blue ticks: the contact sees the message was received while Jarod works on it.
    void this.graph("POST", `${this.config().phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: msg.id,
    }).catch(() => {});
    const allowed = this.config().allowedNumbers.map(normalizeNumber);
    if (!allowed.includes(from)) {
      await this.send(from, this.opts.unknown ? await this.opts.unknown(from, name) : "Accès refusé.");
      return;
    }
    const { text, files } = this.content(msg);
    await this.send(from, await this.handler({ from, name, text, files }));
  }

  /** The text and the files of a message, whatever its type. */
  private content(msg: WaMessage): { text: string; files: IncomingFile[] } {
    const media = msg.image ?? msg.document ?? msg.audio ?? msg.video ?? msg.sticker;
    if (media) {
      const mime = media.mime_type?.split(";")[0]?.trim() || "application/octet-stream";
      const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
      const file: IncomingFile = {
        name: media.filename || `${msg.type}-${media.id}.${ext}`,
        mime,
        download: () => this.downloadMedia(media.id),
      };
      return { text: media.caption ?? "", files: [file] };
    }
    if (msg.text) return { text: msg.text.body, files: [] };
    if (msg.button) return { text: msg.button.text, files: [] };
    const choice = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
    if (choice) return { text: choice.title, files: [] };
    if (msg.location) {
      const { latitude, longitude, name, address } = msg.location;
      return {
        text: `[Position] ${[name, address].filter(Boolean).join(", ")} (${latitude}, ${longitude})`,
        files: [],
      };
    }
    return { text: `[Message WhatsApp de type « ${msg.type} » non pris en charge]`, files: [] };
  }

  private async downloadMedia(id: string): Promise<Buffer> {
    const meta = await this.graph<{ url: string }>("GET", id);
    return downloadFile(meta.url, { Authorization: `Bearer ${this.secrets.token}` });
  }

  private async graph<T = unknown>(method: "GET" | "POST", path: string, body?: unknown | FormData): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.apiBase}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secrets.token}`,
        ...(body && !isForm ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: isForm ? body : JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } };
    if (!res.ok || json.error) throw new Error(explainError(json.error, res.status));
    return json as T;
  }

  async send(to: string, text: string): Promise<void> {
    const number = normalizeNumber(to);
    for (const part of splitMessage(text || "(réponse vide)", MAX_TEXT)) {
      await this.graph("POST", `${this.config().phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: number,
        type: "text",
        text: { body: part, preview_url: false },
      });
    }
  }

  /** Uploads the file to Meta, then sends it as a document of the conversation. */
  async sendFile(to: string, name: string, data: Buffer, caption?: string): Promise<void> {
    const mime = whatsappMime(name);
    if (!mime) throw new Error(`WhatsApp n'accepte pas les fichiers ${extname(name) || "sans extension"}.`);
    const cfg = this.config();
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime);
    form.append("file", new Blob([new Uint8Array(data)], { type: mime }), name);
    const uploaded = await this.graph<{ id: string }>("POST", `${cfg.phoneNumberId}/media`, form);
    await this.graph("POST", `${cfg.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeNumber(to),
      type: "document",
      document: { id: uploaded.id, filename: name, ...(caption ? { caption: caption.slice(0, 1024) } : {}) },
    });
  }
}

/** A Graph API error in words: the codes a user actually meets get an explanation. */
function explainError(error: { message?: string; code?: number } | undefined, status: number): string {
  if (error?.code === 131047 || error?.code === 131026) {
    return "Plus de 24 h depuis le dernier message de ce contact : WhatsApp n'autorise alors que des modèles approuvés. Il doit d'abord réécrire à Jarod.";
  }
  if (error?.code === 190) return "Jeton d'accès WhatsApp expiré ou invalide.";
  return `WhatsApp : ${error?.message ?? `HTTP ${status}`}`;
}

/** The whole body, or null past `max` bytes. */
function readLimited(req: IncomingMessage, max: number): Promise<Buffer | null> {
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
    req.on("end", () => resolve(size > max ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}
