// Portage de packages/core/src/remote/host.ts (rév. 2e180305).
import { createHash, timingSafeEqual } from "node:crypto";
import type { AgentEvent, AgentHooks } from "@jarod/plugin-agent";
import type { GatewayHub } from "./hub.js";
import { type RemoteConfig, type RemoteDevice } from "@jarod/contracts";
import { Emitter } from "@jarod/kernel/util";
export type { RemoteConfig, RemoteDevice };
import {
  b64uEncode,
  type ClientInit,
  type CryptoKeyPair,
  deviceId,
  exportKeyPair,
  generateKeyPair,
  hostHandshake,
  importKeyPair,
  pairingLink,
  randomBytes,
  rawPublicKey,
  type SecureChannel,
} from "./remote-protocol.js";
import type { ApprovalDevices, PhoneApproval } from "./phone-approvals.js";

/** `JarodCore` → les membres publics du hub (`hub.ts`), qui reprend ceux du cœur. */
type JarodCore = Omit<GatewayHub, never>;

export const RELAY_TOKEN_KEY = "remote:relay-token";
const HOST_KEY_SECRET = "remote:host-key";
const PAIRING_TTL_MS = 10 * 60_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;
/** A voice message, decoded: about two minutes of Opus, with room to spare. */
export const MAX_VOICE_BYTES = 3 * 1024 * 1024;
/**
 * A photo or file sent from the phone. Base64 inside a sealed frame grows it by about 1.8: 4 MB keeps
 * the frame under the mobile bridge's 8 MB limit.
 */
export const MAX_REMOTE_FILE_BYTES = 4 * 1024 * 1024;
/** What a phone may send: images, PDFs and plain text. Anything else is refused here, whatever the phone says. */
const REMOTE_FILE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);
const MAX_TITLE = 120;
/** How long a direct channel may stay open without completing its handshake. */
const HANDSHAKE_MS = 15_000;
const TOUCH_MS = 60_000;
/** Speech-to-text answers in this many characters at most, like a typed message. */
const MAX_TEXT = 100_000;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const startsWith = (data: Buffer, ...bytes: number[]) => bytes.every((b, i) => data[i] === b);

/**
 * Whether the bytes are what the declared type says: the leading signature for images and PDFs,
 * valid UTF-8 without NUL bytes for text. The type the phone names is never trusted on its own.
 */
export function contentMatches(mime: string, data: Buffer): boolean {
  switch (mime) {
    case "image/png":
      return startsWith(data, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return startsWith(data, 0xff, 0xd8, 0xff);
    case "image/gif":
      return data.subarray(0, 6).toString("latin1") === "GIF87a" || data.subarray(0, 6).toString("latin1") === "GIF89a";
    case "image/webp":
      return data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP";
    case "application/pdf":
      return data.subarray(0, 5).toString("latin1") === "%PDF-";
    default:
      if (data.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
        return true;
      } catch {
        return false;
      }
  }
}

// RemoteDevice, RemoteConfig (host.ts:25-40) : déplacés dans @jarod/contracts (ré-exportés).

export interface RemoteStatus {
  state: "stopped" | "connecting" | "online" | "error";
  error?: string;
  /** Devices currently connected. */
  clients: number;
}

interface RelayFrame {
  type: "ready" | "open" | "message" | "close";
  cid?: string;
  data?: string;
}

/**
 * How frames reach one client. Through the relay (`kick` asks the relay to cut it), or directly: the
 * phone app on the LAN or over Tailscale, carried by the mobile bridge's `/m1/*` routes.
 */
export interface ClientTransport {
  send(data: string): void;
  close(): void;
}

/** What the mobile bridge holds for one direct channel. */
export interface DirectClient {
  cid: string;
  /** One frame from the phone, in order. */
  receive(data: string): void;
  /** The carrier went away: pending approvals are refused, nothing else is sent. */
  detach(): void;
}

interface Client {
  cid: string;
  direct: boolean;
  transport: ClientTransport;
  channel: SecureChannel | null;
  device: RemoteDevice | null;
  approvals: Map<string, (ok: boolean) => void>;
  /** Broker requests (runs started elsewhere) this device was shown: only those it may answer. */
  offered: Set<string>;
  /** Serializes incoming frames: counters must be checked in order. */
  queue: Promise<void>;
}

interface Rpc {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Converts the relay's https URL into its WebSocket endpoint for hosts. */
export function hostEndpoint(relayUrl: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/ws/host`;
  u.hash = "";
  return u.toString();
}

/**
 * The desktop side of remote access: keeps an outgoing connection to the relay, authenticates
 * paired devices end to end and serves them conversations. The relay only sees ciphertext.
 */
export class RemoteHost extends Emitter<{ status: RemoteStatus }> implements ApprovalDevices {
  private ws: WebSocket | null = null;
  private stopped = true;
  private retries = 0;
  private keys: CryptoKeyPair | null = null;
  private clients = new Map<string, Client>();
  private pairings: { secret: Uint8Array; expiresAt: number }[] = [];
  /**
   * Grows each time a paired phone has something to learn (a notification, an approval waiting). Its
   * value says nothing else: it is what the content-free wake channel hands out. Starts from the clock
   * so a restart never makes it go back.
   */
  private wakeSeq = Date.now();
  private wakeWaiters = new Set<() => void>();
  /** Requests from the approval broker (`phone-approvals.ts`), offered to every app device. */
  private offers = new Map<string, { request: PhoneApproval; answer(ok: boolean): void }>();
  status: RemoteStatus = { state: "stopped", clients: 0 };

  constructor(private readonly core: JarodCore) {
    super();
    // Notifications reach the phones that are connected; the others are only told that there is news.
    core.notifications.on("added", (n) => {
      for (const c of this.clients.values()) {
        if (!c.device) continue;
        void this.push(c, {
          event: "notification",
          data: { id: n.id, kind: n.kind, title: n.title, body: n.body, createdAt: n.createdAt },
        });
      }
      this.bumpWake();
    });
  }

  /** The wake counter, for the long-poll of `/m1/wake`. */
  wakeState(): number {
    return this.wakeSeq;
  }

  /** Resolves with the counter once it moves past `since`, or after `timeoutMs` with what it is then. */
  waitForWake(since: number, timeoutMs: number): Promise<number> {
    if (this.wakeSeq > since) return Promise.resolve(this.wakeSeq);
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.wakeWaiters.delete(finish);
        done(this.wakeSeq);
      };
      const timer = setTimeout(finish, timeoutMs);
      this.wakeWaiters.add(finish);
    });
  }

  private bumpWake(): void {
    this.wakeSeq = Math.max(this.wakeSeq + 1, Date.now());
    for (const wake of [...this.wakeWaiters]) wake();
  }

  /** The paired device a wake token belongs to, or null. Only its hash is kept here. */
  wakeDevice(token: string): RemoteDevice | null {
    if (!token) return null;
    const hash = sha256Hex(token);
    return this.config().devices.find((d) => d.wakeHash && safeEqualHex(d.wakeHash, hash)) ?? null;
  }

  /** Every paired device (relay or direct: the protocol is the same, so is the list). */
  devices(): RemoteDevice[] {
    return this.config().devices;
  }

  private config(): RemoteConfig {
    return this.core.settings.get("remote");
  }

  private setStatus(s: Partial<RemoteStatus>): void {
    this.status = { ...this.status, ...s, clients: [...this.clients.values()].filter((c) => c.channel).length };
    if (s.state && s.state !== "error") delete this.status.error;
    this.emit("status", this.status);
  }

  /** This computer's identity: created once, private key kept in the encrypted secrets. */
  async identity(): Promise<{ hostId: string; keys: CryptoKeyPair }> {
    let cfg = this.config();
    if (!cfg.hostId) {
      cfg = { ...cfg, hostId: b64uEncode(randomBytes(16)) };
      this.core.settings.set("remote", cfg);
    }
    if (!this.keys) {
      const stored = this.core.settings.getSecret(HOST_KEY_SECRET);
      if (stored) this.keys = await importKeyPair(stored);
      else {
        const pair = await generateKeyPair(true);
        this.core.settings.setSecret(HOST_KEY_SECRET, await exportKeyPair(pair));
        this.keys = await importKeyPair(await exportKeyPair(pair));
      }
    }
    return { hostId: cfg.hostId, keys: this.keys };
  }

  async start(): Promise<void> {
    const cfg = this.config();
    const token = this.core.settings.getSecret(RELAY_TOKEN_KEY);
    if (!cfg.enabled || !cfg.relayUrl || !token) return this.setStatus({ state: "stopped" });
    this.stopped = false;
    await this.identity();
    this.connect(token);
  }

  /** Stops the relay. Direct channels belong to the mobile bridge and stay open. */
  stop(): void {
    this.stopped = true;
    this.dropRelayClients();
    this.ws?.close();
    this.ws = null;
    this.setStatus({ state: "stopped" });
  }

  private connect(token: string): void {
    const { relayUrl, hostId } = this.config();
    let ws: WebSocket;
    try {
      ws = new WebSocket(hostEndpoint(relayUrl));
    } catch (e) {
      this.setStatus({ state: "error", error: `URL du relais invalide : ${(e as Error).message}` });
      return;
    }
    this.ws = ws;
    this.setStatus({ state: "connecting" });
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", role: "host", hostId, token })));
    ws.addEventListener("message", (ev) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(String(ev.data)) as RelayFrame;
      } catch {
        return;
      }
      this.onRelayFrame(frame);
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.dropRelayClients();
      if (this.stopped) return;
      if (ev.code === 4401)
        return this.setStatus({ state: "error", error: "Jeton du relais refusé : vérifiez RELAY_TOKEN." });
      this.setStatus({ state: "connecting", error: "Relais injoignable, nouvelle tentative…" });
      this.retries++;
      setTimeout(() => !this.stopped && this.connect(token), Math.min(60_000, 1000 * 2 ** Math.min(this.retries, 6)));
    });
  }

  private dropRelayClients(): void {
    for (const c of [...this.clients.values()]) {
      if (c.direct) continue;
      for (const deny of c.approvals.values()) deny(false);
      this.clients.delete(c.cid);
    }
  }

  private relayTransport(cid: string): ClientTransport {
    return {
      send: (data) => this.ws?.send(JSON.stringify({ type: "send", to: cid, data })),
      close: () => this.ws?.send(JSON.stringify({ type: "kick", to: cid })),
    };
  }

  private newClient(cid: string, transport: ClientTransport, direct: boolean): Client {
    const c: Client = {
      cid,
      direct,
      transport,
      channel: null,
      device: null,
      approvals: new Map(),
      offered: new Set(),
      queue: Promise.resolve(),
    };
    this.clients.set(cid, c);
    return c;
  }

  /**
   * A phone that reached this computer directly (LAN or Tailscale) through the mobile bridge. Same
   * handshake, same devices, same RPC as through the relay; only the carrier differs. A channel that
   * has not proven a paired device within a few seconds is closed.
   */
  attachDirect(transport: ClientTransport): DirectClient {
    const cid = `d-${b64uEncode(randomBytes(16))}`;
    const c = this.newClient(cid, transport, true);
    const deadline = setTimeout(() => {
      if (!c.channel) this.kick(cid);
    }, HANDSHAKE_MS);
    deadline.unref?.();
    return {
      cid,
      receive: (data) => {
        if (!this.clients.has(cid)) return;
        c.queue = c.queue.then(() => this.onClientData(c, data)).catch(() => this.kick(cid));
      },
      detach: () => {
        clearTimeout(deadline);
        this.drop(cid);
      },
    };
  }

  private send(cid: string, data: string): void {
    this.clients.get(cid)?.transport.send(data);
  }

  private kick(cid: string): void {
    this.clients.get(cid)?.transport.close();
    this.drop(cid);
  }

  private drop(cid: string): void {
    const c = this.clients.get(cid);
    if (!c) return;
    for (const deny of c.approvals.values()) deny(false);
    this.clients.delete(cid);
    this.setStatus({});
  }

  private onRelayFrame(f: RelayFrame): void {
    if (f.type === "ready") {
      this.retries = 0;
      this.setStatus({ state: "online" });
    } else if (f.type === "open" && f.cid) {
      // A relay id must never stand for a direct channel (those start with "d-").
      if (f.cid.startsWith("d-")) return;
      this.newClient(f.cid, this.relayTransport(f.cid), false);
    } else if (f.type === "close" && f.cid) {
      if (this.clients.get(f.cid)?.direct) return;
      this.drop(f.cid);
    } else if (f.type === "message" && f.cid && typeof f.data === "string") {
      const c = this.clients.get(f.cid);
      if (!c || c.direct) return;
      const data = f.data;
      c.queue = c.queue.then(() => this.onClientData(c, data)).catch(() => this.kick(c.cid));
    }
  }

  private async onClientData(c: Client, data: string): Promise<void> {
    if (!c.channel) return this.handshake(c, JSON.parse(data) as ClientInit);
    const rpc = (await c.channel.open(data)) as Rpc;
    if (c.device) this.touch(c.device.id);
    let reply: unknown;
    try {
      reply = { id: rpc.id, result: await this.call(c, rpc.method, rpc.params ?? {}) };
    } catch (e) {
      reply = { id: rpc.id, error: (e as Error).message };
    }
    await this.push(c, reply);
  }

  private async handshake(c: Client, init: ClientInit): Promise<void> {
    if (init?.type !== "init") throw new Error("Poignée de main attendue");
    const { keys } = await this.identity();
    const h = await hostHandshake(keys, init);
    const id = await deviceId(h.clientStatic);
    let device = this.config().devices.find((d) => d.id === id) ?? null;
    if (!device && init.pairing) {
      const now = Date.now();
      this.pairings = this.pairings.filter((p) => p.expiresAt > now);
      for (const p of this.pairings) {
        if (await h.checkPairing(p.secret)) {
          this.pairings = this.pairings.filter((x) => x !== p);
          device = {
            id,
            name: (init.name || "Appareil").slice(0, 60),
            publicKey: init.clientStatic,
            pairedAt: now,
            lastSeen: now,
          };
          const cfg = this.config();
          this.core.settings.set("remote", { ...cfg, devices: [...cfg.devices, device] });
          this.core.notifications.add(
            "success",
            "Appareil associé",
            `${device.name} peut maintenant accéder à Jarod-One à distance.`,
          );
          break;
        }
      }
    }
    if (!device) {
      this.send(
        c.cid,
        JSON.stringify({
          type: "denied",
          reason: init.pairing ? "Code d'association invalide ou expiré." : "Appareil inconnu ou révoqué.",
        }),
      );
      return this.kick(c.cid);
    }
    this.send(c.cid, JSON.stringify(h.accept));
    c.channel = h.channel;
    c.device = device;
    this.touch(device.id);
    this.setStatus({});
  }

  private touch(id: string): void {
    const cfg = this.config();
    // Every streamed frame would rewrite the settings: "last seen" to the minute is enough.
    const seen = cfg.devices.find((d) => d.id === id)?.lastSeen ?? 0;
    if (Date.now() - seen < TOUCH_MS) return;
    this.core.settings.set("remote", {
      ...cfg,
      devices: cfg.devices.map((d) => (d.id === id ? { ...d, lastSeen: Date.now() } : d)),
    });
  }

  private async push(c: Client, message: unknown): Promise<void> {
    if (!c.channel || !this.clients.has(c.cid)) return;
    this.send(c.cid, await c.channel.seal(message));
  }

  /**
   * Remote API: a deliberately small surface (conversations only; no settings or keys). Files only go
   * one way: a phone may attach a checked photo or document to a message, never read this computer's.
   */
  private async call(c: Client, method: string, p: Record<string, unknown>): Promise<unknown> {
    const core = this.core;
    const session = (id: unknown) => {
      const s = typeof id === "string" ? core.sessions.get(id) : undefined;
      if (!s) throw new Error("Conversation introuvable");
      return s;
    };
    switch (method) {
      case "hello":
        return { app: "Jarod-One", version: core.appVersion, device: c.device?.name };
      case "sessions.list":
        return core.sessions.list(100).map((s) => ({
          id: s.id,
          title: s.title,
          updatedAt: s.updatedAt,
          pinned: s.pinned,
          running: core.isRunning(s.id),
        }));
      case "sessions.create": {
        const s = core.sessions.create();
        return { id: s.id, title: s.title };
      }
      case "sessions.rename": {
        const s = session(p.sessionId);
        const title = String(p.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
        if (!title) throw new Error("Titre vide");
        core.sessions.rename(s.id, title);
        return { id: s.id, title };
      }
      case "sessions.delete": {
        // The phone asks for a confirmation first; here, the run is stopped and the conversation goes,
        // its attachments with it (like the desktop's delete).
        const s = session(p.sessionId);
        core.stop(s.id);
        core.sessions.delete(s.id);
        return true;
      }
      case "messages.list":
        return core.messages
          .list(session(p.sessionId).id)
          .filter((m) => m.role !== "tool" || m.toolName)
          .slice(-200)
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            toolName: m.toolName,
            isError: m.isError,
            toolCalls: m.toolCalls?.map((t) => ({ id: t.id, name: t.name })),
            // Names and sizes only: the files themselves stay on this computer.
            attachments: m.attachments?.map((a) => ({ name: a.name, mime: a.mime, size: a.size })),
          }));
      case "chat.send": {
        const s = session(p.sessionId);
        const text = String(p.text ?? "").slice(0, MAX_TEXT);
        const r = await core.submit(s.id, text, this.hooksFor(c));
        if (r.kind === "command") return { kind: "command", text: r.result.text ?? "" };
        return { kind: r.kind };
      }
      case "chat.voice": {
        // A voice message: transcribed here, with this computer's speech-to-text (and its network
        // policy), then sent as the person's own words. The phone is told what was heard.
        const s = session(p.sessionId);
        const mime = String(p.mime ?? "");
        if (!/^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,+-]+)?$/i.test(mime)) throw new Error("Format audio non pris en charge");
        const audio = Buffer.from(String(p.audio ?? ""), "base64");
        if (audio.length === 0) throw new Error("Message vocal vide");
        if (audio.length > MAX_VOICE_BYTES) throw new Error("Message vocal trop long");
        const heard = (await core.transcribe(audio, mime)).trim().slice(0, MAX_TEXT);
        if (!heard) return { kind: "empty", text: "" };
        const r = await core.submit(s.id, heard, this.hooksFor(c));
        if (r.kind === "command") return { kind: "command", heard, text: r.result.text ?? "" };
        return { kind: r.kind, heard };
      }
      case "chat.file": {
        // A photo or file from the phone, stored as an attachment of the conversation (encrypted like
        // the desktop's), then sent with the optional caption as one message.
        const s = session(p.sessionId);
        const mime = String(p.mime ?? "").toLowerCase();
        if (!REMOTE_FILE_MIMES.has(mime)) throw new Error("Type de fichier non pris en charge");
        const data = Buffer.from(String(p.data ?? ""), "base64");
        if (data.length === 0) throw new Error("Fichier vide");
        if (data.length > MAX_REMOTE_FILE_BYTES) throw new Error("Fichier trop volumineux (4 Mo au plus)");
        if (!contentMatches(mime, data)) throw new Error("Le contenu ne correspond pas au type annoncé");
        const name = String(p.name ?? "").trim() || "fichier";
        const attachment = core.attachments.save(name, mime, data);
        const text = String(p.text ?? "").slice(0, MAX_TEXT);
        const r = await core.submit(s.id, text, this.hooksFor(c), [attachment]);
        if (r.kind === "busy") core.attachments.deleteUnreferenced([attachment.id]);
        return { kind: r.kind, attachment };
      }
      case "chat.stop":
        core.stop(session(p.sessionId).id);
        return true;
      case "approval.resolve": {
        // One decision for one request: a boolean, and nothing else is read ("always" does not exist).
        const id = String(p.id);
        const resolve = c.approvals.get(id);
        if (resolve) {
          c.approvals.delete(id);
          resolve(p.ok === true);
          return true;
        }
        // A broker request: only a device that was shown it may answer; the first answer wins.
        const offer = c.offered.has(id) ? this.offers.get(id) : undefined;
        c.offered.delete(id);
        offer?.answer(p.ok === true);
        return Boolean(offer);
      }
      case "approvals.pending":
        // Broker requests still waiting, for an app that was closed when they were offered.
        return [...this.offers.values()].map((o) => {
          c.offered.add(o.request.id);
          return o.request;
        });
      case "notifications.list":
        return core.notifications
          .list(50)
          .map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, createdAt: n.createdAt }));
      case "wake.register": {
        // A fresh wake token for this device, replacing the last one. It only ever opens `/m1/wake`,
        // which answers with a counter: no content. Only its hash is written down.
        const token = b64uEncode(randomBytes(32));
        const id = c.device!.id;
        const cfg = this.config();
        this.core.settings.set("remote", {
          ...cfg,
          devices: cfg.devices.map((d) => (d.id === id ? { ...d, wakeHash: sha256Hex(token) } : d)),
        });
        return { token, seq: this.wakeSeq };
      }
      case "device.leave": {
        // The phone forgets this computer: its key is no longer accepted, from now on.
        const id = c.device!.id;
        setTimeout(() => this.revoke(id), 0);
        return true;
      }
      default:
        throw new Error(`Méthode inconnue : ${method}`);
    }
  }

  /** Runs started from a device stream to it (and to the desktop window); approvals go to the device. */
  private hooksFor(c: Client): AgentHooks {
    const desktop = () => this.core.backgroundHooks;
    return {
      emit: (e: AgentEvent) => {
        desktop().emit(e);
        const event = e.type === "message" ? { ...e, message: { ...e.message, raw: undefined } } : e;
        void this.push(c, { event: "agent", data: event });
      },
      approve: (sessionId, call, description) =>
        new Promise<boolean>((resolve) => {
          const id = b64uEncode(randomBytes(9));
          const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
          const finish = (ok: boolean) => {
            clearTimeout(timer);
            c.approvals.delete(id);
            resolve(ok);
          };
          c.approvals.set(id, finish);
          void this.push(c, {
            event: "approval",
            data: {
              id,
              sessionId,
              call: { id: call.id, name: call.name, args: call.args },
              description,
              expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
            },
          });
          this.bumpWake();
        }),
    };
  }

  /** Whether any app device is paired (`ApprovalDevices`). */
  paired(): boolean {
    return this.config().devices.length > 0;
  }

  /** Shows a broker request to every connected app device; the others learn of it from the wake counter. */
  offer(request: PhoneApproval, answer: (ok: boolean) => void): void {
    this.offers.set(request.id, { request, answer });
    for (const c of this.clients.values()) {
      if (!c.device) continue;
      c.offered.add(request.id);
      void this.push(c, { event: "approval", data: request });
    }
    this.bumpWake();
  }

  /** Takes a broker request back: decided elsewhere, timed out or stopped. */
  withdraw(id: string): void {
    this.offers.delete(id);
    for (const c of this.clients.values()) {
      if (!c.offered.delete(id)) continue;
      void this.push(c, { event: "approval-cancelled", data: { id } });
    }
  }

  /** One-time pairing link (valid 10 minutes) to show as a QR code. */
  async startPairing(): Promise<{ link: string; expiresAt: number }> {
    const cfg = this.config();
    if (!cfg.relayUrl) throw new Error("Indiquez d'abord l'adresse du relais.");
    const { hostId, keys } = await this.identity();
    const { secret, expiresAt } = this.newPairingSecret();
    return {
      link: pairingLink(cfg.relayUrl, {
        hostId,
        hostKey: b64uEncode(await rawPublicKey(keys.publicKey)),
        secret,
      }),
      expiresAt,
    };
  }

  /**
   * A one-time secret (valid 10 minutes) for a client that cannot run the key exchange — a browser on
   * the local network. Same store, same lifetime, same one-shot rule as the relay handshake: one code
   * opens either door, and the desktop shows it once.
   */
  newPairingSecret(): { secret: string; expiresAt: number } {
    const secret = randomBytes(32);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairings.push({ secret, expiresAt });
    return { secret: b64uEncode(secret), expiresAt };
  }

  /** Spends a secret presented as-is. False when it is unknown, expired, or already used. */
  claimPairing(presented: string): boolean {
    const now = Date.now();
    this.pairings = this.pairings.filter((p) => p.expiresAt > now);
    const raw = Buffer.from(String(presented ?? ""), "base64url");
    if (raw.length !== 32) return false;
    const hit = this.pairings.find((p) => p.secret.length === raw.length && timingSafeEqual(p.secret, raw));
    if (!hit) return false;
    this.pairings = this.pairings.filter((p) => p !== hit);
    return true;
  }

  /**
   * The phone app's pairing link, to show as a QR code: this computer's key (so the phone can tell it
   * from an impostor), the one-time code (from `newPairingSecret`, so the browser page and the app
   * share it), and the addresses it can be reached on. All in the fragment.
   */
  async appPairingFor(secret: string, addresses: string[], name: string): Promise<{ link: string }> {
    const { hostId, keys } = await this.identity();
    const p = new URLSearchParams({
      v: "2",
      h: hostId,
      k: b64uEncode(await rawPublicKey(keys.publicKey)),
      p: secret,
      u: addresses.join(","),
      n: name.slice(0, 60),
    });
    return { link: `jarod://pair#${p.toString()}` };
  }

  revoke(deviceIdToRevoke: string): void {
    const cfg = this.config();
    this.core.settings.set("remote", { ...cfg, devices: cfg.devices.filter((d) => d.id !== deviceIdToRevoke) });
    for (const c of [...this.clients.values()]) if (c.device?.id === deviceIdToRevoke) this.kick(c.cid);
  }
}
