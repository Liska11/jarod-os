// Portage de packages/core/src/services/email.ts (rév. 2e180305).
import { ImapFlow } from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { Emitter } from "@jarod/kernel/util";
import type { GatewayStatus, IncomingFile } from "./telegram.js";
import { type EmailConfig, EMAIL_PASSWORD_KEY } from "@jarod/contracts";
export { EMAIL_PASSWORD_KEY };
export type { EmailConfig };

/**
 * Email as a messaging gateway: Jarod reads its mailbox over IMAP and answers over SMTP, one
 * conversation per sender. Three rules matter more than the plumbing:
 *
 * - A "From" address proves nothing: anyone can write one. By default a message counts only if the
 *   receiving server authenticated it — `Authentication-Results` with dkim=pass or dmarc=pass for
 *   the sender's own domain (Gmail, Outlook and most providers add it). Anything else is ignored.
 * - Automatic mail (out-of-office, bounces, lists) is never answered: two robots answering each
 *   other is how a mailbox fills up overnight.
 * - Unknown (but authenticated) senders get a pairing code, like the other gateways.
 */

// EmailConfig : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

// EMAIL_PASSWORD_KEY : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  enabled: false,
  imapHost: "",
  imapPort: 993,
  smtpHost: "",
  smtpPort: 465,
  user: "",
  from: "",
  allowedSenders: [],
  requireAuth: true,
  /**
   * Les `authserv-id` de confiance (ex. `["mx.google.com"]`). Vide = aucune épinglage : on se fie au premier
   * en-tête, quel que soit son émetteur. Le renseigner est ce qui ferme le cas d'un message qui n'arrive
   * qu'avec un en-tête `Authentication-Results` écrit par l'expéditeur.
   */
  trustedAuthservIds: [],
  pollSeconds: 60,
  folder: "INBOX",
};

/** Délai d'inactivité du socket IMAP : sans lui, un serveur muet retient la relève pour toujours. */
const IMAP_SOCKET_TIMEOUT_MS = 60_000;
/** Délai maximal du `logout` IMAP : la déconnexion d'un serveur muet ne doit pas retenir la relève. */
const LOGOUT_TIMEOUT_MS = 5_000;
/** Délai maximal d'une relève entière : au-delà, on abandonne pour que le drapeau `polling` retombe. */
const POLL_TIMEOUT_MS = 120_000;

/** Rejette si `p` ne s'est pas résolu dans `ms` : borne un appel qui ne reçoit jamais de réponse. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what} : aucune réponse après ${ms} ms`)),
      ms,
    );
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface IncomingEmail {
  from: string;
  name: string;
  subject: string;
  text: string;
  messageId?: string;
  files: IncomingFile[];
}

const domainOf = (address: string) => address.split("@").pop()!.toLowerCase();

/**
 * True when the FIRST `Authentication-Results` header — the one the receiving MTA wrote, at the top of the
 * message — says the message passed DKIM or DMARC for the sender's domain (or a parent of it for DKIM).
 * SPF alone is not enough: it checks the envelope sender, not the "From" the user reads.
 *
 * Two rules keep a forged header from working:
 *  - only `results[0]` is read. A sender can add their own `Authentication-Results`, but the receiving MTA
 *    PREPENDS its own, so the attacker's copy can never be first;
 *  - when `trustedAuthservIds` is configured, the header's `authserv-id` must be one of them — this is what
 *    rejects a message that arrives with the attacker's header and nothing else (a relay that adds none).
 */
export function isAuthenticated(
  results: string[],
  fromAddress: string,
  trustedAuthservIds: readonly string[] = [],
): boolean {
  const header = results[0];
  if (!header) return false;
  if (trustedAuthservIds.length) {
    const id = authservId(header).toLowerCase();
    if (!id || !trustedAuthservIds.some((t) => t.trim().toLowerCase() === id)) return false;
  }
  const domain = domainOf(fromAddress);
  const covers = (d: string) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`);
  for (const m of header.matchAll(/\bdmarc=pass\b[^;]*?header\.from=([\w.-]+)/gi)) if (covers(m[1]!)) return true;
  for (const m of header.matchAll(/\bdkim=pass\b[^;]*?header\.(?:d|i)=@?([\w.-]+)/gi)) if (covers(m[1]!)) return true;
  return false;
}

/** L'`authserv-id` d'un en-tête `Authentication-Results` (RFC 8601) : le premier jeton, avant le `;`. */
export function authservId(header: string): string {
  const head = (header.split(";", 1)[0] ?? "").replace(/\([^)]*\)/g, " ").trim();
  return head.split(/\s+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
}

/** Out-of-office, bounces, mailing lists: mail no human is waiting an answer for. */
export function isAutomated(headers: Map<string, unknown>, from: string): boolean {
  const get = (k: string) => String(headers.get(k) ?? "").toLowerCase();
  if (get("auto-submitted") && get("auto-submitted") !== "no") return true;
  if (/^(bulk|list|junk|auto_reply)$/.test(get("precedence"))) return true;
  if (headers.has("list-id") || headers.has("x-autoreply") || headers.has("x-autorespond")) return true;
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from);
}

/** The new part of a reply: quoted lines and the "On … wrote:" line are the previous message. */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^(On .+ wrote:|Le .+ a écrit\s?:|-----Original Message-----|De\s?: .+)$/i.test(line.trim())) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

export const replySubject = (subject: string) => (/^re\s*:/i.test(subject) ? subject : `Re: ${subject || "Jarod"}`);

/** The `Authentication-Results` headers of a message, in the order they appear (the first is the topmost). */
function authResults(parsed: ParsedMail): string[] {
  const raw = parsed.headers.get("authentication-results");
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // Seul le PREMIER compte (celui du MTA de réception) : `isAuthenticated` n'en lit pas d'autre, on ne
  // garde donc que celui-là — un en-tête forgé plus bas ne peut pas être pris en compte par erreur.
  return list.slice(0, 1).map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
}

export type EmailHandler = (msg: IncomingEmail) => Promise<string>;

export class EmailGateway extends Emitter<{ status: GatewayStatus }> {
  status: GatewayStatus = { id: "email", state: "stopped" };
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  /** Last message per sender, so a later message (a scheduled task) continues the same thread. */
  private threads = new Map<string, { subject: string; messageId?: string }>();

  constructor(
    private readonly config: () => EmailConfig,
    private readonly password: string,
    private readonly handler: EmailHandler,
    private readonly opts: {
      unknown?: (from: string, name: string) => Promise<string> | string;
      /** Test seams: fetch unread messages, and send one. */
      fetchUnread?: () => Promise<Buffer[]>;
      transport?: (mail: nodemailer.SendMailOptions) => Promise<unknown>;
      onIgnored?: (from: string, why: string) => void;
      /** Test seam: délai maximal d'une relève (défaut `POLL_TIMEOUT_MS`). */
      pollTimeoutMs?: number;
    } = {},
  ) {
    super();
  }

  private setStatus(s: Omit<GatewayStatus, "id">): void {
    this.status = { id: "email", ...s };
    this.emit("status", this.status);
  }

  async start(): Promise<void> {
    const cfg = this.config();
    this.setStatus({ state: "running", botName: cfg.from || cfg.user });
    await this.poll();
    this.timer = setInterval(() => void this.poll(), Math.max(15, cfg.pollSeconds) * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus({ state: "stopped" });
  }

  /** Unread messages of the folder, marked as read as they are taken (each is handled once). */
  private async fetchUnread(): Promise<Buffer[]> {
    if (this.opts.fetchUnread) return this.opts.fetchUnread();
    const cfg = this.config();
    const client = new ImapFlow({
      host: cfg.imapHost,
      port: cfg.imapPort,
      secure: cfg.imapPort === 993,
      auth: { user: cfg.user, pass: this.password },
      logger: false,
      // Un serveur qui ne dit plus rien est coupé au lieu de laisser la relève en suspens.
      socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
    });
    await client.connect();
    const sources: Buffer[] = [];
    const lock = await client.getMailboxLock(cfg.folder || "INBOX");
    try {
      const uids: number[] = [];
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (msg.source) sources.push(msg.source);
        uids.push(msg.uid);
      }
      if (uids.length) await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
    } finally {
      lock.release();
      // `logout` borné : passé le délai, on ferme le socket sans attendre la réponse d'un serveur muet.
      await withTimeout(client.logout(), LOGOUT_TIMEOUT_MS, "Déconnexion IMAP (logout)").catch(() => client.close());
    }
    return sources;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      // Relève bornée : si `fetchUnread` ne rend jamais la main, le drapeau `polling` resterait levé
      // et plus aucune relève n'aurait lieu — un serveur muet arrêterait tout, sans trace.
      const sources = await withTimeout(
        this.fetchUnread(),
        this.opts.pollTimeoutMs ?? POLL_TIMEOUT_MS,
        "Relève IMAP",
      );
      if (this.status.state !== "running")
        this.setStatus({ state: "running", botName: this.config().from || this.config().user });
      for (const source of sources) {
        // Une erreur de traitement est signalée dans le statut (→ journal de `jarod serve`) au lieu
        // d'être avalée : sans trace, le correspondant ne reçoit rien et personne ne le sait.
        await this.handle(source).catch((e: unknown) => {
          this.setStatus({ state: "error", error: `Message ignoré après erreur : ${(e as Error).message}` });
        });
      }
    } catch (e) {
      this.setStatus({ state: "error", error: (e as Error).message });
    } finally {
      this.polling = false;
    }
  }

  private async handle(source: Buffer): Promise<void> {
    const cfg = this.config();
    const parsed = await simpleParser(source);
    const sender = parsed.from?.value[0];
    const from = sender?.address?.toLowerCase() ?? "";
    if (!from) return;
    const own = (cfg.from || cfg.user).toLowerCase();
    if (from === own || isAutomated(parsed.headers, from)) return;
    if (cfg.requireAuth && !isAuthenticated(authResults(parsed), from, cfg.trustedAuthservIds)) {
      this.opts.onIgnored?.(from, "non authentifié (ni DKIM ni DMARC)");
      return;
    }
    const subject = parsed.subject ?? "";
    const messageId = parsed.messageId;
    this.threads.set(from, { subject, ...(messageId ? { messageId } : {}) });
    const name = sender?.name || from;
    if (!cfg.allowedSenders.map((a) => a.toLowerCase()).includes(from)) {
      const text = this.opts.unknown ? await this.opts.unknown(from, name) : "Accès refusé.";
      await this.send(from, text);
      return;
    }
    const body = stripQuoted(parsed.text ?? "") || subject;
    const files: IncomingFile[] = (parsed.attachments ?? []).map((a) => ({
      name: a.filename ?? "piece-jointe",
      mime: a.contentType,
      size: a.size,
      download: async () => a.content,
    }));
    const answer = await this.handler({ from, name, subject, text: body, files, ...(messageId ? { messageId } : {}) });
    await this.send(from, answer);
  }

  private async sendMail(mail: nodemailer.SendMailOptions): Promise<void> {
    if (this.opts.transport) {
      await this.opts.transport(mail);
      return;
    }
    const cfg = this.config();
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.user, pass: this.password },
    });
    await transport.sendMail(mail);
  }

  /** Answers in the sender's thread (Re: subject, In-Reply-To), marked as an automatic reply. */
  private envelope(to: string): nodemailer.SendMailOptions {
    const cfg = this.config();
    const thread = this.threads.get(to.toLowerCase());
    return {
      from: cfg.from || cfg.user,
      to,
      subject: replySubject(thread?.subject ?? ""),
      ...(thread?.messageId ? { inReplyTo: thread.messageId, references: [thread.messageId] } : {}),
      headers: { "Auto-Submitted": "auto-replied" },
    };
  }

  async send(to: string, text: string): Promise<void> {
    await this.sendMail({ ...this.envelope(to), text: text || "(réponse vide)" });
  }

  async sendFile(to: string, name: string, data: Buffer, caption?: string): Promise<void> {
    await this.sendMail({
      ...this.envelope(to),
      text: caption ?? name,
      attachments: [{ filename: name, content: data }],
    });
  }
}
