// Portage de packages/core/src/services/slack.ts (rév. 2e180305).
import { Emitter } from "@jarod/kernel/util";
import type { GatewayStatus, IncomingFile } from "./telegram.js";
import { downloadFile, splitMessage } from "./telegram.js";

export interface SlackMessage {
  channelId: string;
  /** Thread the answer goes to (channel mentions are answered in a thread; DMs are not). */
  threadTs?: string;
  userId: string;
  text: string;
  isDm: boolean;
  files?: IncomingFile[];
}

export type SlackHandler = (msg: SlackMessage) => Promise<string>;

const MAX_MESSAGE = 3900;

/** Converts the model's Markdown to Slack mrkdwn (bold, headings, links, strikethrough). */
export function toMrkdwn(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(/^```\w+\n/, "```\n");
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/!?\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>");
    })
    .join("");
}

/**
 * Slack bot over Socket Mode (no library, no public URL). Needs a bot token (xoxb-) for the Web API
 * and an app-level token (xapp-, scope connections:write) to open the WebSocket. Answers direct
 * messages and mentions from allow-listed users; everyone else gets their user id back.
 */
export class SlackGateway extends Emitter<{ status: GatewayStatus }> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private botId: string | null = null;
  private retries = 0;
  status: GatewayStatus = { id: "slack", state: "stopped" };

  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly allowed: () => string[],
    private readonly handler: SlackHandler,
    private readonly opts: {
      apiBase?: string;
      /** What an unknown user is told (pairing code); by default, how to allow them by hand. */
      unknown?: (userId: string, channelId: string) => Promise<string> | string;
    } = {},
  ) {
    super();
  }

  private get api(): string {
    return this.opts.apiBase ?? "https://slack.com/api";
  }

  private setStatus(s: Omit<GatewayStatus, "id">): void {
    this.status = { id: "slack", ...(this.status.botName ? { botName: this.status.botName } : {}), ...s };
    this.emit("status", this.status);
  }

  /** Web API call. Slack answers HTTP 200 with `ok: false` on errors. */
  private async call<T>(method: string, token: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Slack ${method} : HTTP ${res.status}`);
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new Error(`Slack ${method} : ${json.error ?? "erreur inconnue"}`);
    return json;
  }

  /** A Web API call with form-encoded arguments (the file upload methods do not take JSON). */
  private async form<T>(method: string, args: Record<string, string>): Promise<T> {
    const res = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.botToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(args).toString(),
    });
    if (!res.ok) throw new Error(`Slack ${method} : HTTP ${res.status}`);
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new Error(`Slack ${method} : ${json.error ?? "erreur inconnue"}`);
    return json;
  }

  /** Sends a file in three steps: ask for an upload URL, upload, then share it in the channel (or thread). */
  async sendFile(channelId: string, name: string, data: Buffer, caption?: string, threadTs?: string): Promise<void> {
    const up = await this.form<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
      filename: name,
      length: String(data.length),
    });
    const res = await fetch(up.upload_url, { method: "POST", body: new Uint8Array(data) });
    if (!res.ok) throw new Error(`Slack envoi du fichier : HTTP ${res.status}`);
    await this.form("files.completeUploadExternal", {
      files: JSON.stringify([{ id: up.file_id, title: name }]),
      channel_id: channelId,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(caption ? { initial_comment: caption.slice(0, 3000) } : {}),
    });
  }

  async send(channelId: string, text: string, threadTs?: string): Promise<void> {
    for (const part of splitMessage(toMrkdwn(text || "(réponse vide)"), MAX_MESSAGE)) {
      await this.call("chat.postMessage", this.botToken, {
        channel: channelId,
        text: part,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      const me = await this.call<{ user_id: string; user: string }>("auth.test", this.botToken);
      this.botId = me.user_id;
      this.status.botName = me.user;
    } catch (e) {
      this.setStatus({ state: "error", error: friendly((e as Error).message) });
      return;
    }
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
    if (this.status.state !== "error") this.setStatus({ state: "stopped" });
  }

  private async connect(): Promise<void> {
    let url: string;
    try {
      url = (await this.call<{ url: string }>("apps.connections.open", this.appToken)).url;
    } catch (e) {
      const message = (e as Error).message;
      // Bad app token: retrying won't help.
      if (/invalid_auth|not_authed|not_allowed_token_type/.test(message))
        return this.setStatus({ state: "error", error: friendly(message) });
      return this.reconnectLater();
    }
    if (this.stopped) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener("message", (ev) => void this.onFrame(JSON.parse(String(ev.data))));
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) this.reconnectLater();
    });
  }

  private reconnectLater(): void {
    this.retries++;
    setTimeout(() => !this.stopped && void this.connect(), Math.min(60_000, 1000 * 2 ** this.retries));
  }

  private async onFrame(frame: { type: string; envelope_id?: string; payload?: any }): Promise<void> {
    // Every envelope must be acknowledged within 3 s or Slack redelivers it.
    if (frame.envelope_id) this.ws?.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    if (frame.type === "hello") {
      this.retries = 0;
      this.setStatus({ state: "running" });
    } else if (frame.type === "disconnect") {
      this.ws?.close();
    } else if (frame.type === "events_api" && frame.payload?.event) {
      await this.handleEvent(frame.payload.event);
    }
  }

  /** Handles an Events API event. Public for tests. */
  async handleEvent(ev: any): Promise<void> {
    // "file_share" is a message carrying files; other subtypes are edits, joins, bot posts…
    if (ev.bot_id || (ev.subtype && ev.subtype !== "file_share") || !ev.user || ev.user === this.botId) return;
    const isDm = ev.type === "message" && ev.channel_type === "im";
    // Channel messages arrive both as `message` and `app_mention`: only the mention counts.
    if (!isDm && ev.type !== "app_mention") return;
    const text = String(ev.text ?? "")
      .replace(new RegExp(`<@${this.botId}>`, "g"), "")
      .trim();
    // Private file URLs need the bot token (scope files:read).
    const files: IncomingFile[] = (Array.isArray(ev.files) ? ev.files : [])
      .filter((f: { url_private_download?: string; url_private?: string }) => f.url_private_download ?? f.url_private)
      .map(
        (f: {
          url_private_download?: string;
          url_private?: string;
          name?: string;
          mimetype?: string;
          size?: number;
        }) => ({
          name: f.name ?? "fichier",
          mime: f.mimetype ?? "application/octet-stream",
          ...(f.size ? { size: f.size } : {}),
          download: () =>
            downloadFile((f.url_private_download ?? f.url_private)!, { authorization: `Bearer ${this.botToken}` }),
        }),
      );
    const msg: SlackMessage = {
      channelId: ev.channel,
      userId: ev.user,
      text,
      isDm,
      ...(files.length ? { files } : {}),
      ...(isDm ? (ev.thread_ts ? { threadTs: ev.thread_ts } : {}) : { threadTs: ev.thread_ts ?? ev.ts }),
    };
    try {
      if (!this.allowed().includes(msg.userId)) {
        await this.send(
          msg.channelId,
          this.opts.unknown
            ? await this.opts.unknown(msg.userId, msg.channelId)
            : `Accès refusé. Pour m'autoriser à vous répondre, ajoutez l'identifiant ${msg.userId} dans Jarod-One → Paramètres → Passerelles.`,
          msg.threadTs,
        );
        return;
      }
      if (!text && files.length === 0) return;
      await this.send(msg.channelId, await this.handler(msg), msg.threadTs);
    } catch (e) {
      await this.send(msg.channelId, `Erreur : ${(e as Error).message}`, msg.threadTs).catch(() => {});
    }
  }
}

function friendly(message: string): string {
  if (/auth\.test.*(invalid_auth|not_authed)/.test(message)) return "Jeton de bot Slack (xoxb-) invalide.";
  if (/apps\.connections\.open.*(invalid_auth|not_authed)/.test(message))
    return "Jeton d'application Slack (xapp-) invalide.";
  if (/not_allowed_token_type/.test(message))
    return "Le jeton d'application doit commencer par xapp- et avoir la portée connections:write (Socket Mode activé).";
  return message;
}
