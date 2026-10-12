// Portage de packages/core/src/services/telegram.ts (rév. 2e180305).
import { Emitter } from "@jarod/kernel/util";
import { type GatewayStatus } from "@jarod/contracts";
export type { GatewayStatus };

// GatewayStatus : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

/** A photo, document or voice message received through a gateway, downloaded on demand. */
export interface IncomingFile {
  name: string;
  mime: string;
  size?: number;
  download(): Promise<Buffer>;
}

export interface IncomingMessage {
  chatId: string;
  text: string;
  from: string;
  files?: IncomingFile[];
}

/** Downloads a URL into memory, refusing anything larger than `max` bytes. */
export async function downloadFile(
  url: string,
  headers: Record<string, string> = {},
  max = 25 * 1024 * 1024,
): Promise<Buffer> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Téléchargement impossible (HTTP ${res.status})`);
  const size = Number(res.headers.get("content-length") ?? 0);
  if (size > max) throw new Error(`Fichier trop volumineux (${Math.round(size / 1024 / 1024)} Mo)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`Fichier trop volumineux (${Math.round(buf.length / 1024 / 1024)} Mo)`);
  return buf;
}

type TelegramFileRef = { file_id: string; file_size?: number };
type TelegramMessage = {
  chat: { id: number };
  text?: string;
  caption?: string;
  from?: { first_name?: string; username?: string };
  photo?: TelegramFileRef[];
  document?: TelegramFileRef & { file_name?: string; mime_type?: string };
  voice?: TelegramFileRef & { mime_type?: string };
  audio?: TelegramFileRef & { file_name?: string; mime_type?: string };
};

export type MessageHandler = (msg: IncomingMessage) => Promise<string>;

const MAX_MESSAGE = 4000;

/** Splits a long answer on paragraph/line boundaries to fit Telegram's 4096-char limit. */
export function splitMessage(text: string, max = MAX_MESSAGE): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Telegram bot over long polling: no public URL or webhook needed. Only allow-listed chats
 * reach the agent; anyone else gets their chat id back so the owner can allow it.
 */
export class TelegramGateway extends Emitter<{ status: GatewayStatus }> {
  private controller: AbortController | null = null;
  private offset = 0;
  status: GatewayStatus = { id: "telegram", state: "stopped" };

  constructor(
    private readonly token: string,
    private readonly allowed: () => string[],
    private readonly handler: MessageHandler,
    private readonly apiBase = "https://api.telegram.org",
    /** What an unknown chat is told (pairing code); by default, how to allow it by hand. */
    private readonly unknown?: (chatId: string, name: string) => Promise<string> | string,
  ) {
    super();
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(json.description ?? `Telegram ${method} a échoué`);
    return json.result;
  }

  /** Sends a file as a document (Telegram accepts up to 50 MB from a bot). */
  async sendFile(chatId: string, name: string, data: Buffer, caption?: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    if (caption) form.append("caption", caption.slice(0, 1024));
    form.append("document", new Blob([new Uint8Array(data)]), name);
    const res = await fetch(`${this.apiBase}/bot${this.token}/sendDocument`, { method: "POST", body: form });
    const json = (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; description?: string };
    if (!json.ok) throw new Error(json.description ?? `Telegram sendDocument : HTTP ${res.status}`);
  }

  private setStatus(s: Omit<GatewayStatus, "id">): void {
    // Jarod-cordis (B3) : le jeton est dans chaque URL de l'API ; une erreur qui la cite (URL invalide…) ne le
    // publie jamais (statut → journal de `jarod serve`, écran Passerelles).
    if (s.error && this.token) s = { ...s, error: s.error.split(this.token).join("<jeton>") };
    this.status = { id: "telegram", ...s };
    this.emit("status", this.status);
  }

  async start(): Promise<void> {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    try {
      const me = await this.call<{ username: string }>("getMe", {}, controller.signal);
      this.setStatus({ state: "running", botName: me.username });
    } catch (e) {
      this.setStatus({ state: "error", error: (e as Error).message });
      return;
    }
    void this.loop(controller);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.status.state === "running") this.setStatus({ state: "stopped" });
  }

  async send(chatId: string, text: string): Promise<void> {
    for (const part of splitMessage(text || "(réponse vide)")) {
      await this.call("sendMessage", { chat_id: chatId, text: part });
    }
  }

  private async loop(controller: AbortController): Promise<void> {
    let failures = 0;
    while (!controller.signal.aborted) {
      try {
        const updates = await this.call<{ update_id: number; message?: TelegramMessage }[]>(
          "getUpdates",
          { offset: this.offset, timeout: 25, allowed_updates: ["message"] },
          controller.signal,
        );
        failures = 0;
        for (const u of updates) {
          const m = u.message;
          const files = m ? this.filesOf(m) : [];
          const text = m?.text ?? m?.caption ?? "";
          // Rien à traiter (mise à jour sans message, ou sans texte ni fichier) : l'offset peut être
          // avancé tout de suite, il n'y a rien à rejouer.
          if (!m || (!text && files.length === 0)) {
            this.offset = u.update_id + 1;
            continue;
          }
          // L'offset n'est avancé qu'APRÈS la fin du traitement, et le traitement est attendu (donc
          // sérialisé) : Telegram ne tient une mise à jour pour acquise que lorsqu'un `getUpdates` est
          // rappelé avec le nouvel offset. Un incident en cours de traitement la laisse en attente côté
          // serveur, donc rejouée au tour suivant, au lieu d'être perdue.
          await this.handle({
            chatId: String(m.chat.id),
            text,
            from: m.from?.username ?? m.from?.first_name ?? "?",
            ...(files.length ? { files } : {}),
          });
          this.offset = u.update_id + 1;
        }
      } catch (e) {
        if (controller.signal.aborted) break;
        failures++;
        this.setStatus({
          state: failures > 3 ? "error" : "running",
          error: (e as Error).message,
          ...(this.status.botName ? { botName: this.status.botName } : {}),
        });
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
      }
    }
  }

  /** Photos, documents and voice messages of a message, as lazily downloaded files. */
  filesOf(m: TelegramMessage): IncomingFile[] {
    const file = (ref: TelegramFileRef, name: string, mime: string): IncomingFile => ({
      name,
      mime,
      ...(ref.file_size ? { size: ref.file_size } : {}),
      download: async () => {
        const f = await this.call<{ file_path?: string }>("getFile", { file_id: ref.file_id });
        if (!f.file_path) throw new Error("Fichier Telegram indisponible (plus de 20 Mo ?)");
        return downloadFile(`${this.apiBase}/file/bot${this.token}/${f.file_path}`);
      },
    });
    const out: IncomingFile[] = [];
    const photo = m.photo?.at(-1); // largest size
    if (photo) out.push(file(photo, "photo.jpg", "image/jpeg"));
    if (m.document)
      out.push(
        file(m.document, m.document.file_name ?? "document", m.document.mime_type ?? "application/octet-stream"),
      );
    if (m.voice) out.push(file(m.voice, "message-vocal.ogg", m.voice.mime_type ?? "audio/ogg"));
    if (m.audio) out.push(file(m.audio, m.audio.file_name ?? "audio", m.audio.mime_type ?? "audio/mpeg"));
    return out;
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    try {
      if (!this.allowed().includes(msg.chatId)) {
        await this.send(
          msg.chatId,
          this.unknown
            ? await this.unknown(msg.chatId, msg.from)
            : `Accès refusé. Pour autoriser cette conversation, ajoutez l'identifiant ${msg.chatId} dans Jarod-One → Paramètres → Passerelles.`,
        );
        return;
      }
      if (msg.text === "/start") {
        await this.send(
          msg.chatId,
          "Bonjour, je suis Jarod. Écrivez-moi comme dans l'application. /new démarre une nouvelle conversation.",
        );
        return;
      }
      void this.call("sendChatAction", { chat_id: msg.chatId, action: "typing" }).catch(() => {});
      const reply = await this.handler(msg);
      await this.send(msg.chatId, reply);
    } catch (e) {
      await this.send(msg.chatId, `Erreur : ${(e as Error).message}`).catch(() => {});
    }
  }
}
