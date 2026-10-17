// Portage de packages/core/src/services/discord.ts (rév. 2e180305).
import { Emitter } from "@jarod/kernel/util";
import type { GatewayStatus, IncomingFile } from "./telegram.js";
import { downloadFile, splitMessage } from "./telegram.js";

export interface DiscordMessage {
  channelId: string;
  userId: string;
  username: string;
  text: string;
  isDm: boolean;
  files?: IncomingFile[];
}

export type DiscordHandler = (msg: DiscordMessage) => Promise<string>;

// Gateway intents: GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (privileged: enable it in the developer portal).
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const MAX_MESSAGE = 1900;

interface GatewayPayload {
  op: number;
  d?: any;
  s?: number | null;
  t?: string | null;
}

/**
 * Discord bot over the Gateway WebSocket (no library). Answers direct messages and mentions
 * from allow-listed users; everyone else gets their user id back.
 */
export class DiscordGateway extends Emitter<{ status: GatewayStatus }> {
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private seq: number | null = null;
  private stopped = true;
  private botId: string | null = null;
  private retries = 0;
  status: GatewayStatus = { id: "discord", state: "stopped" };

  constructor(
    private readonly token: string,
    private readonly allowed: () => string[],
    private readonly handler: DiscordHandler,
    private readonly opts: {
      apiBase?: string;
      /** Délai d'UN appel d'API (défaut 60 s) : un serveur qui ne répond pas ne suspend pas un envoi. */
      requestTimeoutMs?: number;
      gatewayUrl?: string;
      /** What an unknown user is told (pairing code); by default, how to allow them by hand. */
      unknown?: (userId: string, name: string, channelId: string) => Promise<string> | string;
    } = {},
  ) {
    super();
  }

  private get timeout(): AbortSignal {
    return AbortSignal.timeout(this.opts.requestTimeoutMs ?? 60_000);
  }

  private get api(): string {
    return this.opts.apiBase ?? "https://discord.com/api/v10";
  }

  private setStatus(s: Omit<GatewayStatus, "id">): void {
    this.status = { id: "discord", ...s };
    this.emit("status", this.status);
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: this.timeout,
    });
    if (!res.ok) throw new Error(`Discord ${method} ${path} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** Sends a file as a message attachment. */
  async sendFile(channelId: string, name: string, data: Buffer, caption?: string): Promise<void> {
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content: (caption ?? "").slice(0, MAX_MESSAGE),
        allowed_mentions: { parse: [] },
        attachments: [{ id: 0, filename: name }],
      }),
    );
    form.append("files[0]", new Blob([new Uint8Array(data)]), name);
    const res = await fetch(`${this.api}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${this.token}` },
      body: form,
      signal: this.timeout,
    });
    if (!res.ok) throw new Error(`Discord envoi de fichier : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  async send(channelId: string, text: string): Promise<void> {
    for (const part of splitMessage(text || "(réponse vide)", MAX_MESSAGE)) {
      await this.rest("POST", `/channels/${channelId}/messages`, { content: part, allowed_mentions: { parse: [] } });
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      const me = await this.rest<{ id: string; username: string }>("GET", "/users/@me");
      this.botId = me.id;
      this.status.botName = me.username;
    } catch (e) {
      this.setStatus({ state: "error", error: (e as Error).message });
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws?.close();
    this.ws = null;
    if (this.status.state !== "error") this.setStatus({ state: "stopped" });
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.gatewayUrl ?? "wss://gateway.discord.gg/?v=10&encoding=json");
    this.ws = ws;
    ws.addEventListener("message", (ev) => this.onPayload(JSON.parse(String(ev.data)) as GatewayPayload));
    ws.addEventListener("close", (ev) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.stopped) return;
      // 4004 = bad token, 4014 = privileged intent (message content) not enabled: don't loop.
      if (ev.code === 4004 || ev.code === 4014) {
        this.setStatus({
          state: "error",
          error:
            ev.code === 4004
              ? "Jeton Discord invalide."
              : "Activez « Message Content Intent » dans le portail développeur Discord.",
        });
        return;
      }
      this.retries++;
      setTimeout(() => !this.stopped && this.connect(), Math.min(60_000, 1000 * 2 ** this.retries));
    });
  }

  private onPayload(p: GatewayPayload): void {
    if (p.s != null) this.seq = p.s;
    if (p.op === 10) {
      const interval = p.d.heartbeat_interval as number;
      this.heartbeat = setInterval(() => this.ws?.send(JSON.stringify({ op: 1, d: this.seq })), interval);
      this.ws?.send(
        JSON.stringify({
          op: 2,
          d: {
            token: this.token,
            intents: INTENTS,
            properties: { os: process.platform, browser: "jarod-one", device: "jarod-one" },
          },
        }),
      );
    } else if (p.op === 1) {
      this.ws?.send(JSON.stringify({ op: 1, d: this.seq }));
    } else if (p.op === 7 || p.op === 9) {
      this.ws?.close(4000);
    } else if (p.op === 0 && p.t) {
      void this.handleDispatch(p.t, p.d);
    }
  }

  /** Handles a Gateway dispatch event. Public for tests. */
  async handleDispatch(type: string, d: any): Promise<void> {
    if (type === "READY") {
      this.retries = 0;
      this.botId = d.user?.id ?? this.botId;
      this.setStatus({ state: "running", botName: d.user?.username ?? this.status.botName });
      return;
    }
    if (type !== "MESSAGE_CREATE" || d.author?.bot) return;
    const isDm = !d.guild_id;
    const mentioned = Array.isArray(d.mentions) && d.mentions.some((m: { id: string }) => m.id === this.botId);
    if (!isDm && !mentioned) return;
    const text = String(d.content ?? "")
      .replace(new RegExp(`<@!?${this.botId}>`, "g"), "")
      .trim();
    // Attachment URLs are signed CDN links: no token needed to download them.
    const files: IncomingFile[] = (Array.isArray(d.attachments) ? d.attachments : []).map(
      (a: { url: string; filename?: string; content_type?: string; size?: number }) => ({
        name: a.filename ?? "fichier",
        mime: a.content_type ?? "application/octet-stream",
        ...(a.size ? { size: a.size } : {}),
        download: () => downloadFile(a.url),
      }),
    );
    const msg: DiscordMessage = {
      channelId: d.channel_id,
      userId: d.author.id,
      username: d.author.global_name ?? d.author.username,
      text,
      isDm,
      ...(files.length ? { files } : {}),
    };
    try {
      if (!this.allowed().includes(msg.userId)) {
        await this.send(
          msg.channelId,
          this.opts.unknown
            ? await this.opts.unknown(msg.userId, msg.username, msg.channelId)
            : `Accès refusé. Pour m'autoriser à vous répondre, ajoutez l'identifiant ${msg.userId} dans Jarod-One → Paramètres → Passerelles.`,
        );
        return;
      }
      if (!text && files.length === 0) return;
      void this.rest("POST", `/channels/${msg.channelId}/typing`).catch(() => {});
      await this.send(msg.channelId, await this.handler(msg));
    } catch (e) {
      await this.send(msg.channelId, `Erreur : ${(e as Error).message}`).catch(() => {});
    }
  }
}
