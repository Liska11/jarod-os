// Portage de packages/core/src/remote/host.ts (rév. 2e180305).
import { timingSafeEqual } from "node:crypto";
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

/** `JarodCore` → les membres publics du hub (`hub.ts`), qui reprend ceux du cœur. */
type JarodCore = Omit<GatewayHub, never>;

export const RELAY_TOKEN_KEY = "remote:relay-token";
const HOST_KEY_SECRET = "remote:host-key";
const PAIRING_TTL_MS = 10 * 60_000;
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

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

interface Client {
  cid: string;
  channel: SecureChannel | null;
  device: RemoteDevice | null;
  approvals: Map<string, (ok: boolean) => void>;
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
export class RemoteHost extends Emitter<{ status: RemoteStatus }> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private retries = 0;
  private keys: CryptoKeyPair | null = null;
  private clients = new Map<string, Client>();
  private pairings: { secret: Uint8Array; expiresAt: number }[] = [];
  status: RemoteStatus = { state: "stopped", clients: 0 };

  constructor(private readonly core: JarodCore) {
    super();
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

  stop(): void {
    this.stopped = true;
    for (const c of this.clients.values()) for (const deny of c.approvals.values()) deny(false);
    this.clients.clear();
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
      for (const c of this.clients.values()) for (const deny of c.approvals.values()) deny(false);
      this.clients.clear();
      if (this.stopped) return;
      if (ev.code === 4401)
        return this.setStatus({ state: "error", error: "Jeton du relais refusé : vérifiez RELAY_TOKEN." });
      this.setStatus({ state: "connecting", error: "Relais injoignable, nouvelle tentative…" });
      this.retries++;
      setTimeout(() => !this.stopped && this.connect(token), Math.min(60_000, 1000 * 2 ** Math.min(this.retries, 6)));
    });
  }

  private send(cid: string, data: string): void {
    this.ws?.send(JSON.stringify({ type: "send", to: cid, data }));
  }

  private kick(cid: string): void {
    this.ws?.send(JSON.stringify({ type: "kick", to: cid }));
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
      this.clients.set(f.cid, {
        cid: f.cid,
        channel: null,
        device: null,
        approvals: new Map(),
        queue: Promise.resolve(),
      });
    } else if (f.type === "close" && f.cid) {
      this.drop(f.cid);
    } else if (f.type === "message" && f.cid && typeof f.data === "string") {
      const c = this.clients.get(f.cid);
      if (!c) return;
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
    this.core.settings.set("remote", {
      ...cfg,
      devices: cfg.devices.map((d) => (d.id === id ? { ...d, lastSeen: Date.now() } : d)),
    });
  }

  private async push(c: Client, message: unknown): Promise<void> {
    if (!c.channel || !this.clients.has(c.cid)) return;
    this.send(c.cid, await c.channel.seal(message));
  }

  /** Remote API: a deliberately small surface (conversations only; no settings, files or keys). */
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
          }));
      case "chat.send": {
        const s = session(p.sessionId);
        const text = String(p.text ?? "").slice(0, 100_000);
        const r = await core.submit(s.id, text, this.hooksFor(c));
        if (r.kind === "command") return { kind: "command", text: r.result.text ?? "" };
        return { kind: r.kind };
      }
      case "chat.stop":
        core.stop(session(p.sessionId).id);
        return true;
      case "approval.resolve": {
        const resolve = c.approvals.get(String(p.id));
        c.approvals.delete(String(p.id));
        resolve?.(p.ok === true);
        return Boolean(resolve);
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
            data: { id, sessionId, call: { id: call.id, name: call.name, args: call.args }, description },
          });
        }),
    };
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

  revoke(deviceIdToRevoke: string): void {
    const cfg = this.config();
    this.core.settings.set("remote", { ...cfg, devices: cfg.devices.filter((d) => d.id !== deviceIdToRevoke) });
    for (const c of [...this.clients.values()]) if (c.device?.id === deviceIdToRevoke) this.kick(c.cid);
  }
}
