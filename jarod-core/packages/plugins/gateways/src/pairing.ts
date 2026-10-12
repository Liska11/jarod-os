// Portage de packages/core/src/services/pairing.ts (rév. 2e180305).
import { randomInt } from "node:crypto";
import type { Db } from "@jarod/plugin-storage";
import { now } from "@jarod/kernel/util";
import type { NotificationService } from "@jarod/plugin-storage";
import type { SettingsService } from "@jarod/plugin-storage";

/**
 * Pairing for the messaging gateways (Hermes Agent's DM pairing): someone the bot does not know
 * gets a one-time code instead of a flat refusal, the owner sees the request in the app and approves
 * the code (`/pair approve CODE` or the settings screen), which adds them to the gateway's allowlist.
 * Approval only ever happens in the app: a chat, even an allowed one, cannot let someone else in.
 */

export type PairingGateway = "telegram" | "discord" | "slack" | "email" | "whatsapp";

export interface PairingRequest {
  code: string;
  gateway: PairingGateway;
  /** What goes into the allowlist: the chat id (Telegram) or the user id (Discord, Slack). */
  subjectId: string;
  name: string;
  /** Where to tell them they are in (their chat or DM channel). */
  replyTo: string;
  createdAt: number;
  expiresAt: number;
}

interface Row {
  code: string;
  gateway: string;
  subject_id: string;
  name: string;
  reply_to: string;
  created_at: number;
  expires_at: number;
}

const toRequest = (r: Row): PairingRequest => ({
  code: r.code,
  gateway: r.gateway as PairingGateway,
  subjectId: r.subject_id,
  name: r.name,
  replyTo: r.reply_to,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export const PAIRING_TTL_MS = 60 * 60_000;
/** No 0/O or 1/I: the code is read on one screen and typed on another. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_PENDING = 20;

const ALLOWLIST: Record<PairingGateway, (s: SettingsService) => { get(): string[]; set(ids: string[]): void }> = {
  telegram: (s) => ({
    get: () => s.get("telegram").allowedChatIds,
    set: (ids) => s.set("telegram", { ...s.get("telegram"), allowedChatIds: ids }),
  }),
  discord: (s) => ({
    get: () => s.get("discord").allowedUserIds,
    set: (ids) => s.set("discord", { ...s.get("discord"), allowedUserIds: ids }),
  }),
  slack: (s) => ({
    get: () => s.get("slack").allowedUserIds,
    set: (ids) => s.set("slack", { ...s.get("slack"), allowedUserIds: ids }),
  }),
  email: (s) => ({
    get: () => s.get("email").allowedSenders,
    set: (ids) => s.set("email", { ...s.get("email"), allowedSenders: ids }),
  }),
  whatsapp: (s) => ({
    get: () => s.get("whatsapp").allowedNumbers,
    set: (ids) => s.set("whatsapp", { ...s.get("whatsapp"), allowedNumbers: ids }),
  }),
};

export class PairingService {
  constructor(
    private readonly d: {
      db: Db;
      settings: SettingsService;
      notifications: NotificationService;
      /** Tells the newcomer they are in (best effort). */
      send?: (gateway: PairingGateway, chatId: string, text: string) => Promise<void>;
    },
  ) {}

  private prune(at = now()): void {
    this.d.db.run("DELETE FROM gateway_pairings WHERE expires_at <= ?", at);
  }

  list(at = now()): PairingRequest[] {
    this.prune(at);
    return this.d.db.all<Row>("SELECT * FROM gateway_pairings ORDER BY created_at").map(toRequest);
  }

  /**
   * An unknown sender wrote to the bot: returns the text to answer them with. The same sender gets
   * the same code until it expires, so writing again does not flood the owner with requests.
   */
  request(gateway: PairingGateway, subjectId: string, name: string, replyTo: string, at = now()): string {
    this.prune(at);
    const existing = this.d.db.get<Row>(
      "SELECT * FROM gateway_pairings WHERE gateway = ? AND subject_id = ?",
      gateway,
      subjectId,
    );
    if (existing) return this.reply(existing.code);
    if ((this.d.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM gateway_pairings")?.n ?? 0) >= MAX_PENDING) {
      return "Accès refusé : trop de demandes en attente. Réessayez plus tard.";
    }
    const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const label = name.replace(/\s+/g, " ").trim().slice(0, 80) || subjectId;
    this.d.db.run(
      "INSERT INTO gateway_pairings (code, gateway, subject_id, name, reply_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      code,
      gateway,
      subjectId,
      label,
      replyTo,
      at,
      at + PAIRING_TTL_MS,
    );
    this.d.notifications.add(
      "info",
      `Demande d'accès ${gateway}`,
      `${label} (${subjectId}) demande à parler à Jarod. Code : ${code}. Pour accepter : /pair approve ${code} (ou Paramètres → Passerelles).`,
    );
    return this.reply(code);
  }

  private reply(code: string): string {
    return `Je ne vous connais pas encore. Votre code d'appairage : ${code}\nTransmettez-le au propriétaire de ce Jarod : il l'approuvera dans l'application (valable 1 h).`;
  }

  /** Approves a code: the sender joins the gateway's allowlist and is told so. */
  async approve(rawCode: string, at = now()): Promise<PairingRequest> {
    this.prune(at);
    const code = rawCode.trim().toUpperCase();
    const row = this.d.db.get<Row>("SELECT * FROM gateway_pairings WHERE code = ?", code);
    if (!row) throw new Error(`Code inconnu ou expiré : ${code}`);
    const req = toRequest(row);
    const list = ALLOWLIST[req.gateway](this.d.settings);
    const ids = list.get();
    if (!ids.includes(req.subjectId)) list.set([...ids, req.subjectId]);
    this.d.db.run("DELETE FROM gateway_pairings WHERE code = ?", code);
    await this.d
      .send?.(req.gateway, req.replyTo, "Accès accordé : vous pouvez maintenant écrire à Jarod.")
      .catch(() => {});
    return req;
  }

  deny(rawCode: string): boolean {
    return this.d.db.run("DELETE FROM gateway_pairings WHERE code = ?", rawCode.trim().toUpperCase()).changes > 0;
  }
}
