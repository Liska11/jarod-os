/**
 * Les passerelles de messagerie telles que `JarodCore` (packages/core/src/core.ts, rév. 2e180305)
 * les pilotait : `sync*()`, `gatewayStatus()`, `handleGatewayMessage()`, `receiveFiles()`, et
 * l'aiguillage d'envoi de `deliver`/`deliverFile`. Corps de méthode repris tels quels (fichier:lignes
 * en commentaire), mêmes noms de membres (`this.telegram`, `this.pairing`, `this.options`…).
 *
 * Seul le câblage change : ce que le cœur possédait vient du runtime de plugin-agent, et une
 * passerelle posée dans `this.telegram` (…) s'enregistre d'elle-même dans `runtime.gateways` — c'est
 * par là que `runtime.deliver` (tâches planifiées, appairage, `present`) l'atteint, avec le même
 * contrat : absente = « la passerelle X n'est pas connectée ».
 */
import { randomBytes } from "node:crypto";
import {
  type Attachment,
  DISCORD_TOKEN_KEY,
  EMAIL_PASSWORD_KEY,
  type GatewayStatus,
  type GatewaysConfig,
  SLACK_APP_TOKEN_KEY,
  SLACK_BOT_TOKEN_KEY,
  TELEGRAM_TOKEN_KEY,
  WHATSAPP_APP_SECRET_KEY,
  WHATSAPP_TOKEN_KEY,
} from "@jarod/contracts";
import { Emitter } from "@jarod/kernel/util";
import type { AgentRuntime, GatewaySender } from "@jarod/plugin-agent";
import { MAX_ATTACHMENT_BYTES } from "@jarod/plugin-rag";
import { AndroidService } from "./android.js";
import { DiscordGateway } from "./discord.js";
import { EmailGateway } from "./email.js";
import { MobileBridge } from "./mobile.js";
import { PairingService } from "./pairing.js";
import { PhoneApprovalBroker } from "./phone-approvals.js";
import { RemoteHost, type RemoteStatus } from "./remote-host.js";
import { SlackGateway } from "./slack.js";
import { type IncomingFile, TelegramGateway } from "./telegram.js";
import { WHATSAPP_VERIFY_TOKEN_KEY, WhatsAppGateway } from "./whatsapp.js";

type GatewayId = GatewayStatus["id"];

interface Live {
  telegram: TelegramGateway | null;
  discord: DiscordGateway | null;
  slack: SlackGateway | null;
  email: EmailGateway | null;
  whatsapp: WhatsAppGateway | null;
}

export interface GatewayHubDeps {
  runtime: AgentRuntime;
  /** Speech-to-text (`core.transcribe`, core.ts:1112-1114). */
  transcribe(audio: Buffer, mime: string): Promise<string>;
  options?: GatewaysConfig;
}

/** Ce que le cœur émettait (`core.emit("gateway", st)`) ; plugin-gateways le relaie en `gateway:status`. */
export class GatewayHub extends Emitter<{ gateway: GatewayStatus; remote: RemoteStatus }> {
  readonly pairing: PairingService;
  // core.ts:247-248,318 (pont téléphone, W9)
  readonly mobile: MobileBridge;
  readonly android: AndroidService;
  /** Approvals from runs the phone did not start, offered to the app too (setting `phoneApprovals`). */
  readonly phoneApprovals: PhoneApprovalBroker;
  remote: RemoteHost | null = null;
  readonly options: GatewaysConfig;
  private readonly live: Live = { telegram: null, discord: null, slack: null, email: null, whatsapp: null };
  private readonly core: AgentRuntime;
  private readonly transcribeWith: GatewayHubDeps["transcribe"];

  constructor(d: GatewayHubDeps) {
    super();
    this.core = d.runtime;
    this.transcribeWith = d.transcribe;
    this.options = d.options ?? {};
    // core.ts:605-610
    this.pairing = new PairingService({
      db: this.db,
      settings: this.settings,
      notifications: this.notifications,
      send: (gateway, chatId, text) => this.core.deliver({ gateway, chatId }, text),
    });
    // core.ts:504-509
    this.android = new AndroidService({
      events: this.events,
      adbPath: () => this.settings.getAll().android.adbPath,
      timeoutMs: () => this.settings.getAll().android.timeoutMs,
    });
    this.mobile = new MobileBridge(this);
    this.phoneApprovals = new PhoneApprovalBroker({
      enabled: () => this.settings.get("phoneApprovals") === true,
      devices: () => this.remoteHost(),
    });
  }

  // Ce que les corps portés lisent sur `this` (membres de `JarodCore`).
  get db() {
    return this.core.db;
  }
  get settings() {
    return this.core.settings;
  }
  get notifications() {
    return this.core.notifications;
  }
  get events() {
    return this.core.events;
  }
  get sessions() {
    return this.core.sessions;
  }
  get commands() {
    return this.core.commands;
  }
  get attachments() {
    return this.core.attachments;
  }
  get backgroundHooks() {
    return this.core.backgroundHooks;
  }
  get messages() {
    return this.core.messages;
  }
  get appVersion() {
    return this.core.appVersion;
  }
  runAndWait(...args: Parameters<AgentRuntime["runAndWait"]>): ReturnType<AgentRuntime["runAndWait"]> {
    return this.core.runAndWait(...args);
  }
  submit(...args: Parameters<AgentRuntime["submit"]>): ReturnType<AgentRuntime["submit"]> {
    return this.core.submit(...args);
  }
  isRunning(sessionId: string): boolean {
    return this.core.isRunning(sessionId);
  }
  stop(sessionId: string): void {
    this.core.stop(sessionId);
  }

  // core.ts:1021-1032
  remoteStatus(): RemoteStatus {
    return this.remote?.status ?? { state: "stopped", clients: 0 };
  }

  /** The remote host, created on first use: only pairing and the relay need it. */
  remoteHost(): RemoteHost {
    if (!this.remote) {
      this.remote = new RemoteHost(this);
      this.remote.on("status", (st) => this.emit("remote", st));
    }
    return this.remote;
  }
  transcribe(audio: Buffer, mime: string): Promise<string> {
    return this.transcribeWith(audio, mime);
  }

  // core.ts:270-274 — poser une passerelle l'enregistre dans `runtime.gateways` (aiguillage de core.ts:1497-1540).
  get telegram(): TelegramGateway | null {
    return this.live.telegram;
  }
  set telegram(gw: TelegramGateway | null) {
    this.live.telegram = gw;
    this.register("telegram", gw && { send: (chatId, text) => gw.send(chatId, text), sendFile: (c, n, d, cap) => gw.sendFile(c, n, d, cap) });
  }
  get discord(): DiscordGateway | null {
    return this.live.discord;
  }
  set discord(gw: DiscordGateway | null) {
    this.live.discord = gw;
    this.register("discord", gw && { send: (chatId, text) => gw.send(chatId, text), sendFile: (c, n, d, cap) => gw.sendFile(c, n, d, cap) });
  }
  get slack(): SlackGateway | null {
    return this.live.slack;
  }
  set slack(gw: SlackGateway | null) {
    this.live.slack = gw;
    // core.ts:1506-1511, 1529-1534
    this.register(
      "slack",
      gw && {
        send: async (chatId, text) => {
          const { channel, thread } = this.slackTarget(chatId);
          await gw.send(channel, text, thread);
        },
        sendFile: async (chatId, name, data, caption) => {
          const { channel, thread } = this.slackTarget(chatId);
          await gw.sendFile(channel, name, data, caption, thread);
        },
      },
    );
  }
  get email(): EmailGateway | null {
    return this.live.email;
  }
  set email(gw: EmailGateway | null) {
    this.live.email = gw;
    this.register("email", gw && { send: (to, text) => gw.send(to, text), sendFile: (to, n, d, cap) => gw.sendFile(to, n, d, cap) });
  }
  get whatsapp(): WhatsAppGateway | null {
    return this.live.whatsapp;
  }
  set whatsapp(gw: WhatsAppGateway | null) {
    this.live.whatsapp = gw;
    this.register("whatsapp", gw && { send: (to, text) => gw.send(to, text), sendFile: (to, n, d, cap) => gw.sendFile(to, n, d, cap) });
  }

  private register(id: GatewayId, sender: GatewaySender | null): void {
    if (sender) this.core.gateways.set(id, sender);
    else this.core.gateways.delete(id);
  }

  /** Démarre les passerelles activées (`init()`, core.ts:684-688). */
  syncAll(): void {
    void this.syncTelegram();
    void this.syncDiscord();
    void this.syncSlack();
    void this.syncEmail();
    void this.syncWhatsApp();
  }

  /** Arrête toutes les passerelles (`dispose()`, core.ts:1772-1778, relais compris). */
  stopAll(): void {
    for (const id of ["telegram", "discord", "slack", "email", "whatsapp"] as const) {
      this.live[id]?.stop();
      this[id] = null;
    }
    this.remote?.stop();
    this.phoneApprovals.cancelAll();
  }

  // ---------- Gateways ----------

  // core.ts:989-995
  gatewayStatus(id: GatewayStatus["id"] = "telegram"): GatewayStatus {
    if (id === "discord") return this.discord?.status ?? { id: "discord", state: "stopped" };
    if (id === "slack") return this.slack?.status ?? { id: "slack", state: "stopped" };
    if (id === "email") return this.email?.status ?? { id: "email", state: "stopped" };
    if (id === "whatsapp") return this.whatsapp?.status ?? { id: "whatsapp", state: "stopped" };
    return this.telegram?.status ?? { id: "telegram", state: "stopped" };
  }

  /** (Re)starts or stops the Discord bot to match the settings. (core.ts:997-1019) */
  async syncDiscord(): Promise<void> {
    this.discord?.stop();
    this.discord = null;
    const cfg = this.settings.get("discord");
    const token = this.settings.getSecret(DISCORD_TOKEN_KEY);
    if (!cfg.enabled || !token) {
      this.emit("gateway", { id: "discord", state: "stopped" });
      return;
    }
    const gw = new DiscordGateway(
      token,
      () => this.settings.get("discord").allowedUserIds,
      (msg) => this.handleGatewayMessage("discord", msg.channelId, msg.text, msg.username, msg.files),
      {
        ...(this.options.discordApiBase ? { apiBase: this.options.discordApiBase } : {}),
        unknown: (userId, name, channelId) => this.pairing.request("discord", userId, name, channelId),
      },
    );
    gw.on("status", (st) => this.emit("gateway", st));
    this.discord = gw;
    await gw.start();
  }

  /** (Re)starts or stops the Slack bot to match the settings. (core.ts:1041-1073) */
  async syncSlack(): Promise<void> {
    this.slack?.stop();
    this.slack = null;
    const cfg = this.settings.get("slack");
    const botToken = this.settings.getSecret(SLACK_BOT_TOKEN_KEY);
    const appToken = this.settings.getSecret(SLACK_APP_TOKEN_KEY);
    if (!cfg.enabled || !botToken || !appToken) {
      this.emit("gateway", { id: "slack", state: "stopped" });
      return;
    }
    const gw = new SlackGateway(
      botToken,
      appToken,
      () => this.settings.get("slack").allowedUserIds,
      // Each Slack thread is its own conversation; a DM without thread is one long conversation.
      (msg) =>
        this.handleGatewayMessage(
          "slack",
          msg.threadTs ? `${msg.channelId}:${msg.threadTs}` : msg.channelId,
          msg.text,
          msg.userId,
          msg.files,
        ),
      {
        ...(this.options.slackApiBase ? { apiBase: this.options.slackApiBase } : {}),
        unknown: (userId, channelId) => this.pairing.request("slack", userId, userId, channelId),
      },
    );
    gw.on("status", (st) => this.emit("gateway", st));
    this.slack = gw;
    await gw.start();
  }

  /** (Re)starts the email gateway from its settings and password. (core.ts:1158-1181) */
  async syncEmail(): Promise<void> {
    this.email?.stop();
    this.email = null;
    const cfg = this.settings.get("email");
    const password = this.settings.getSecret(EMAIL_PASSWORD_KEY);
    if (!cfg.enabled || !password || !cfg.imapHost || !cfg.smtpHost || !cfg.user) {
      this.emit("gateway", { id: "email", state: "stopped" });
      return;
    }
    const gw = new EmailGateway(
      () => this.settings.get("email"),
      password,
      (msg) => this.handleGatewayMessage("email", msg.from, msg.text, msg.name, msg.files),
      {
        unknown: (from, name) => this.pairing.request("email", from, name, from),
        // Spoofed or spam mail: kept in the log, not in the notifications.
        onIgnored: (from, why) => this.events.append("gateway:email", "ignored", { from, why }),
      },
    );
    gw.on("status", (st) => this.emit("gateway", st));
    this.email = gw;
    await gw.start();
  }

  /**
   * The token Meta must echo when the webhook is saved in its console. Created on first use: it is
   * not a credential (the app secret signs the messages), only proof the webhook is ours.
   * (core.ts:1183-1193)
   */
  whatsappVerifyToken(): string {
    const existing = this.settings.getSecret(WHATSAPP_VERIFY_TOKEN_KEY);
    if (existing) return existing;
    const token = randomBytes(18).toString("base64url");
    this.settings.setSecret(WHATSAPP_VERIFY_TOKEN_KEY, token);
    return token;
  }

  /** (Re)starts the WhatsApp gateway (Meta Cloud API) from its settings and secrets. (core.ts:1195-1219) */
  async syncWhatsApp(): Promise<void> {
    this.whatsapp?.stop();
    this.whatsapp = null;
    const cfg = this.settings.get("whatsapp");
    const token = this.settings.getSecret(WHATSAPP_TOKEN_KEY);
    const appSecret = this.settings.getSecret(WHATSAPP_APP_SECRET_KEY);
    if (!cfg.enabled || !token || !appSecret || !cfg.phoneNumberId) {
      this.emit("gateway", { id: "whatsapp", state: "stopped" });
      return;
    }
    const gw = new WhatsAppGateway(
      () => this.settings.get("whatsapp"),
      { token, appSecret, verifyToken: this.whatsappVerifyToken() },
      (msg) => this.handleGatewayMessage("whatsapp", msg.from, msg.text, msg.name, msg.files),
      {
        ...(this.options.whatsappApiBase ? { apiBase: this.options.whatsappApiBase } : {}),
        unknown: (from, name) => this.pairing.request("whatsapp", from, name, from),
        onIgnored: (why) => this.events.append("gateway:whatsapp", "ignored", { why }),
      },
    );
    gw.on("status", (st) => this.emit("gateway", st));
    this.whatsapp = gw;
    await gw.start();
  }

  /** (Re)starts or stops the Telegram bot to match the settings. (core.ts:1293-1313) */
  async syncTelegram(): Promise<void> {
    this.telegram?.stop();
    this.telegram = null;
    const cfg = this.settings.get("telegram");
    const token = this.settings.getSecret(TELEGRAM_TOKEN_KEY);
    if (!cfg.enabled || !token) {
      this.emit("gateway", { id: "telegram", state: "stopped" });
      return;
    }
    const gw = new TelegramGateway(
      token,
      () => this.settings.get("telegram").allowedChatIds,
      (msg) => this.handleGatewayMessage("telegram", msg.chatId, msg.text, msg.from, msg.files),
      this.options.telegramApiBase,
      (chatId, name) => this.pairing.request("telegram", chatId, name, chatId),
    );
    gw.on("status", (st) => this.emit("gateway", st));
    this.telegram = gw;
    await gw.start();
  }

  /**
   * Turns files received through a gateway into attachments; voice and audio messages are
   * transcribed into text instead (when speech-to-text is configured). (core.ts:1315-1342)
   */
  private async receiveFiles(files: IncomingFile[]): Promise<{ attachments: Attachment[]; notes: string[] }> {
    const attachments: Attachment[] = [];
    const notes: string[] = [];
    for (const f of files) {
      try {
        if (f.size && f.size > MAX_ATTACHMENT_BYTES)
          throw new Error(`trop volumineux (${Math.round(f.size / 1024 / 1024)} Mo)`);
        const data = await f.download();
        if (f.mime.startsWith("audio/")) {
          try {
            const said = (await this.transcribe(data, f.mime)).trim();
            notes.push(said ? `[Message vocal] ${said}` : "[Message vocal vide]");
            continue;
          } catch (e) {
            notes.push(`[Message vocal non transcrit : ${(e as Error).message}]`);
          }
        }
        attachments.push(this.attachments.save(f.name, f.mime, data));
      } catch (e) {
        notes.push(`[Pièce jointe « ${f.name} » ignorée : ${(e as Error).message}]`);
      }
    }
    return { attachments, notes };
  }

  /** A message from a messaging gateway: each chat gets its own conversation. (core.ts:1344-1381) */
  async handleGatewayMessage(
    gateway: string,
    chatId: string,
    text: string,
    from: string,
    files: IncomingFile[] = [],
  ): Promise<string> {
    const row = this.db.get<{ session_id: string }>(
      "SELECT session_id FROM gateway_chats WHERE gateway = ? AND chat_id = ?",
      gateway,
      chatId,
    );
    let sessionId = row && this.sessions.get(row.session_id) ? row.session_id : null;
    const isNew = text.trim() === "/new";
    if (isNew || !sessionId) {
      sessionId = this.sessions.create(`\u{1F4F1} ${from}`).id;
      this.db.run(
        "INSERT INTO gateway_chats (gateway, chat_id, session_id) VALUES (?, ?, ?) ON CONFLICT(gateway, chat_id) DO UPDATE SET session_id = excluded.session_id",
        gateway,
        chatId,
        sessionId,
      );
      if (isNew) return "Nouvelle conversation démarrée.";
    }
    let prompt = text;
    if (/^\/pair\b/i.test(text.trim())) return "Commande disponible uniquement dans l'application.";
    if (text.trim().startsWith("/") && files.length === 0) {
      // Canal distant : la commande passe par le garde et les accords (Q19-2), pas par le composer.
      const r = await this.core.executeRemoteCommand(text.trim(), sessionId, this.backgroundHooks);
      if (r?.action === "send" && r.payload) prompt = r.payload;
      else return r?.text ?? (r?.action ? "Commande disponible uniquement dans l'application." : "OK");
    }
    const { attachments, notes } = await this.receiveFiles(files);
    prompt = [prompt, ...notes].filter((p) => p.trim()).join("\n\n");
    if (!prompt && attachments.length === 0) return notes.join("\n") || "(message vide)";
    const result = await this.runAndWait(sessionId, prompt, this.backgroundHooks, attachments);
    return result.error ? `Erreur : ${result.error}` : result.text || "(pas de réponse)";
  }

  /**
   * A Slack conversation that lives in a thread is recorded as `channel:thread`: that is one chat for
   * Jarod, but two arguments for Slack. (core.ts:1487-1494)
   */
  private slackTarget(chatId: string): { channel: string; thread?: string } {
    const [channel, thread] = chatId.split(":");
    return thread ? { channel: channel!, thread } : { channel: chatId };
  }
}
