// Portage de packages/core/src/services/mobile.ts (rév. 2e180305).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import type { AgentEvent, AgentHooks } from "@jarod/plugin-agent";
import type { GatewayHub } from "./hub.js";
import { MOBILE_APP, MOBILE_PAGE } from "./mobile-page.js";
import type { DirectClient } from "./remote-host.js";
import { isPrivateAddress } from "./remote-protocol.js";

export { isPrivateAddress };

/** `JarodCore` → les membres publics du hub (`hub.ts`), qui reprend ceux du cœur. */
type JarodCore = Omit<GatewayHub, never>;

const MAX_BODY = 512 * 1024;
/** Failed pairings allowed per address per window. Counting failures, not requests. */
const PAIR_ATTEMPTS = 5;
const PAIR_WINDOW_MS = 10 * 60_000;
/** How often a device's "last seen" is written: every request would rewrite the settings. */
const TOUCH_MS = 60_000;
/** One frame from the phone app: a voice message, base64 inside base64, fits with room to spare. */
const MAX_FRAME = 8 * 1024 * 1024;
/** Direct channels open at once, in all and from one address (a phone needs one). */
const MAX_DIRECT = 32;
const MAX_DIRECT_PER_ADDRESS = 4;
/** Frames kept for a channel whose stream is not attached yet (the handshake answer, mostly). */
const MAX_PENDING_FRAMES = 64;
/** A wake long-poll answers within this time even when nothing happened (proxies cut idle requests). */
export const WAKE_POLL_MS = 25_000;
/** Where the Android app's page comes from (Capacitor, `server.androidScheme: "http"`). */
export const APP_ORIGIN = "http://localhost";

export interface MobileDeviceInfo {
  deviceId: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
  /** "browser": the page served here (bearer token); "app": the Android app (device key, end-to-end). */
  kind: "browser" | "app";
}

export interface MobileStatus {
  running: boolean;
  port: number;
  /** What to type on the phone, or "" when this computer has no network address to offer. */
  url: string;
  devices: MobileDeviceInfo[];
}

const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vboxnet|vmnet|br-/i;

/** Tailscale's IPv4 range: listed after the LAN, which is shorter when the phone is home. */
function isTailscale(address: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(address);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

interface DirectChannel {
  client: DirectClient;
  address: string;
  stream: ServerResponse | null;
  pending: string[];
}

/**
 * A phone on the same network, served by this app — same pairing as the relay, but for a browser,
 * which cannot do the key exchange. The page is served here (no build step), the pairing secret is
 * the one the desktop already shows, and a run started from the phone refuses dangerous tools: a
 * phone cannot approve what it cannot see.
 */
export class MobileBridge {
  private server: Server | null = null;
  private streams = new Set<{ res: ServerResponse; sessionId: string | null; deviceId: string }>();
  private attempts = new Map<string, { count: number; until: number }>();
  private direct = new Map<string, DirectChannel>();
  /** One wake long-poll per device: a new one replaces the old. */
  private wakePolls = new Map<string, ServerResponse>();

  constructor(private readonly core: JarodCore) {}

  status(): MobileStatus {
    const all = this.core.settings.getAll();
    const port = this.port();
    const browsers = all.mobile.devices.map(({ deviceId, name, pairedAt, lastSeen }) => ({
      deviceId,
      name,
      pairedAt,
      lastSeen,
      kind: "browser" as const,
    }));
    const apps = all.remote.devices.map(({ id, name, pairedAt, lastSeen }) => ({
      deviceId: id,
      name,
      pairedAt,
      lastSeen,
      kind: "app" as const,
    }));
    return {
      running: this.server !== null,
      port,
      url: this.server ? this.url(port) : "",
      devices: [...apps, ...browsers],
    };
  }

  /** Every address of this computer a phone may use, LAN first, then Tailscale. */
  addresses(port = this.port()): string[] {
    const lan: string[] = [];
    const tailnet: string[] = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      // Virtual adapters (Hyper-V, WSL, VirtualBox, VMware, Docker) lead nowhere a phone can be.
      if (VIRTUAL_ADAPTER.test(name)) continue;
      for (const net of list ?? []) {
        if (net.family !== "IPv4" || net.internal || !isPrivateAddress(net.address)) continue;
        // Link-local: what a computer gives itself when there is no network.
        if (net.address.startsWith("169.254.")) continue;
        (isTailscale(net.address) ? tailnet : lan).push(`http://${net.address}:${port}`);
      }
    }
    return [...new Set([...lan, ...tailnet])];
  }

  /**
   * The Android app's pairing link (and the browser's, from the same one-time code): the app link
   * carries this computer's key and every address it can be reached on.
   */
  async appPairing(): Promise<{ url: string; appLink: string; secret: string; expiresAt: number }> {
    const browser = this.pairing();
    const { link } = await this.core.remoteHost().appPairingFor(browser.secret, this.addresses(), hostname());
    return { ...browser, appLink: link };
  }

  /** The port in use, or the one that would be. */
  private port(): number {
    const address = this.server?.address();
    if (address && typeof address === "object") return address.port;
    return this.core.settings.getAll().mobile.port;
  }

  /** The address a phone can reach. "" when this computer is on no network at all. */
  private url(port: number): string {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === "IPv4" && !net.internal) return `http://${net.address}:${port}`;
      }
    }
    return "";
  }

  /**
   * The link to show as a code. The secret comes from the same pairing the relay path uses, so the
   * desktop shows one code whichever door the phone takes.
   */
  pairing(): { url: string; secret: string; expiresAt: number } {
    const port = this.port();
    const { secret, expiresAt } = this.core.remoteHost().newPairingSecret();
    const url = this.url(port);
    return { url: url ? `${url}/#${secret}` : "", secret, expiresAt };
  }

  async start(port?: number): Promise<MobileStatus> {
    if (this.server) return this.status();
    const wanted = port ?? this.core.settings.getAll().mobile.port;
    const server = createServer((req, res) => {
      void this.route(req, res).catch((e: unknown) => {
        this.json(res, 500, { error: (e as Error).message });
      });
    });
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(wanted, "0.0.0.0", () => {
        server.off("error", fail);
        done();
      });
    });
    this.server = server;
    const cfg = this.core.settings.getAll();
    this.core.settings.set("mobile", { ...cfg.mobile, enabled: true, port: this.port() });
    this.core.notifications.add(
      "success",
      "Téléphone associé",
      `Le pont local écoute sur ${this.url(this.port()) || `le port ${this.port()}`}.`,
    );
    return this.status();
  }

  async stop(): Promise<MobileStatus> {
    const server = this.server;
    for (const stream of [...this.streams]) stream.res.end();
    this.streams.clear();
    this.closeDirect();
    if (server) {
      await new Promise<void>((done) => server.close(() => done()));
      this.server = null;
    }
    const cfg = this.core.settings.getAll();
    this.core.settings.set("mobile", { ...cfg.mobile, enabled: false });
    return this.status();
  }

  /**
   * Jarod-cordis : libère le port à l'arrêt du kernel SANS toucher au réglage `enabled` — un pont
   * allumé revient au prochain démarrage. (La source ne fermait pas le pont dans `dispose` :
   * le processus Electron mourait avec.) Même fermeture que `stop()`.
   */
  async close(): Promise<void> {
    const server = this.server;
    for (const stream of [...this.streams]) stream.res.end();
    this.streams.clear();
    this.closeDirect();
    if (server) {
      await new Promise<void>((done) => server.close(() => done()));
      this.server = null;
    }
  }

  private closeDirect(): void {
    for (const ch of [...this.direct.values()]) {
      ch.client.detach();
      ch.stream?.end();
    }
    this.direct.clear();
    for (const res of this.wakePolls.values()) res.end();
    this.wakePolls.clear();
  }

  /**
   * Drops a device, from either side of the app. Its token (browser) or its key (app) stops working
   * immediately, and its open streams are cut.
   */
  revoke(deviceId: string): MobileStatus {
    if (this.core.settings.getAll().remote.devices.some((d) => d.id === deviceId)) {
      this.core.remoteHost().revoke(deviceId);
      this.wakePolls.get(deviceId)?.end();
      this.wakePolls.delete(deviceId);
      return this.status();
    }
    this.dropDevice(deviceId);
    // Only that device's streams: revoking one phone must not cut the others off.
    for (const stream of [...this.streams]) {
      if (stream.deviceId !== deviceId) continue;
      stream.res.end();
      this.streams.delete(stream);
    }
    return this.status();
  }

  // ---------- HTTP ----------

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    // No cross-origin header at all: a page elsewhere on the web cannot read an answer from here.

    if (!isPrivateAddress(req.socket.remoteAddress ?? "")) {
      // Not this computer, not a local network, not the tailnet: nothing here, not even the page.
      req.resume();
      return this.json(res, 403, { error: "adresse non autorisée" });
    }

    if (url.pathname.startsWith("/m1/")) return this.routeDirect(req, res, url);

    if (req.method === "GET" && url.pathname === "/") {
      return this.html(res, MOBILE_PAGE);
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      // Served as its own file, so the page needs no inline script and no exception to the policy.
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:");
      res.end(MOBILE_APP);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/pair") {
      return this.pair(req, res);
    }

    const device = this.device(req, url);
    if (!device) return this.json(res, 401, { error: "association requise" });

    if (req.method === "GET" && url.pathname === "/api/status") {
      const all = this.core.settings.getAll();
      return this.json(res, 200, { app: "Jarod-One", model: all.activeModel, workspace: all.workspace ?? "" });
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const sessions = this.core.sessions.list().slice(0, 40);
      return this.json(
        res,
        200,
        sessions.map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt })),
      );
    }
    if (req.method === "GET" && url.pathname === "/api/session") {
      const id = url.searchParams.get("id") ?? "";
      if (!this.core.sessions.get(id)) return this.json(res, 404, { error: "conversation inconnue" });
      const messages = this.core.messages
        .list(id)
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
        .slice(-60)
        .map((m) => ({ role: m.role, text: m.content }));
      return this.json(res, 200, messages);
    }
    if (req.method === "POST" && url.pathname === "/api/ask") {
      const body = await this.body(req);
      const sessionId = String(body.sessionId ?? "");
      const text = String(body.text ?? "").trim();
      if (!text) return this.json(res, 400, { error: "message vide" });
      if (!this.core.sessions.get(sessionId)) return this.json(res, 404, { error: "conversation inconnue" });
      this.ask(sessionId, text);
      return this.json(res, 202, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      const sessionId = url.searchParams.get("session") ?? null;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": pont local\n\n");
      const stream = { res, sessionId, deviceId: device.deviceId };
      this.streams.add(stream);
      req.on("close", () => this.streams.delete(stream));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/leave") {
      this.dropDevice(device.deviceId);
      return this.json(res, 200, { ok: true });
    }
    return this.json(res, 404, { error: "inconnu" });
  }

  // ---------- The Android app: the end-to-end channel, carried directly ----------

  /**
   * `/m1/open` → a channel id; `/m1/down` → the PC's frames (Server-Sent Events); `/m1/up` → one frame
   * from the phone. What travels is the `jarod-relay/1` protocol, sealed end to end: HTTP carries no
   * secret, and nothing is answered to anyone before the handshake has proven a paired device.
   * `/m1/wake` is the closed app's long-poll: a counter, never content.
   */
  private async routeDirect(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // The app's own origin (Capacitor serves it from http://localhost). Opening this door to a page
    // gives it nothing: every frame needs the device key, the wake answer needs the wake token.
    res.setHeader("access-control-allow-origin", APP_ORIGIN);
    res.setHeader("vary", "origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    const address = req.socket.remoteAddress ?? "";
    if (req.method === "POST" && url.pathname === "/m1/open") {
      req.resume();
      const fromHere = [...this.direct.values()].filter((c) => c.address === address).length;
      if (this.direct.size >= MAX_DIRECT || fromHere >= MAX_DIRECT_PER_ADDRESS) {
        return this.json(res, 429, { error: "trop de canaux ouverts" });
      }
      const holder: { ch?: DirectChannel } = {};
      const client = this.core.remoteHost().attachDirect({
        send: (data) => {
          const ch = holder.ch;
          if (!ch) return;
          if (ch.stream && !ch.stream.writableEnded) ch.stream.write(`data: ${data}\n\n`);
          else if (ch.pending.length < MAX_PENDING_FRAMES) ch.pending.push(data);
        },
        close: () => {
          const ch = holder.ch;
          if (!ch) return;
          this.direct.delete(client.cid);
          ch.stream?.end();
        },
      });
      holder.ch = { client, address, stream: null, pending: [] };
      this.direct.set(client.cid, holder.ch);
      return this.json(res, 200, { cid: client.cid, v: "jarod-relay/1" });
    }
    if (req.method === "GET" && url.pathname === "/m1/down") {
      const ch = this.direct.get(url.searchParams.get("cid") ?? "");
      // The channel is bound to the address that opened it, and to one stream.
      if (!ch || ch.address !== address || ch.stream) return this.json(res, 404, { error: "canal inconnu" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": canal direct\n\n");
      ch.stream = res;
      for (const data of ch.pending.splice(0)) res.write(`data: ${data}\n\n`);
      const keepAlive = setInterval(() => res.write(": .\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        // The stream is the channel's life: when it goes, so does the channel (the app reconnects).
        if (this.direct.get(ch.client.cid) === ch) this.direct.delete(ch.client.cid);
        ch.client.detach();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/m1/up") {
      const ch = this.direct.get(url.searchParams.get("cid") ?? "");
      if (!ch || ch.address !== address) {
        req.resume();
        return this.json(res, 404, { error: "canal inconnu" });
      }
      const frame = await this.text(req, MAX_FRAME);
      ch.client.receive(frame);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/m1/wake") {
      const header = req.headers.authorization ?? "";
      const device = this.core.remoteHost().wakeDevice(header.startsWith("Bearer ") ? header.slice(7) : "");
      if (!device) return this.json(res, 401, { error: "jeton de réveil inconnu" });
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      this.wakePolls.get(device.id)?.end();
      this.wakePolls.set(device.id, res);
      let open = true;
      req.on("close", () => {
        open = false;
        if (this.wakePolls.get(device.id) === res) this.wakePolls.delete(device.id);
      });
      // The phone may ask for a shorter wait (a quick check when it comes back on the network).
      const asked = Number(url.searchParams.get("wait") ?? WAKE_POLL_MS);
      const wait = Number.isFinite(asked) ? Math.min(WAKE_POLL_MS, Math.max(0, asked)) : WAKE_POLL_MS;
      const seq = await this.core.remoteHost().waitForWake(since, wait);
      if (this.wakePolls.get(device.id) === res) this.wakePolls.delete(device.id);
      // Only a counter: whether something happened and how many times, never what.
      if (open) this.json(res, 200, { seq, news: seq > since, count: this.core.remoteHost().wakeCount(since) });
      return;
    }
    req.resume();
    return this.json(res, 404, { error: "inconnu" });
  }

  private async text(req: IncomingMessage, limit: number): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error("corps trop volumineux");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? "";
    if (!this.mayTry(ip)) return this.json(res, 429, { error: "trop de tentatives : redemandez un code" });
    const body = await this.body(req);
    const secret = String(body.secret ?? "");
    if (!this.core.remoteHost().claimPairing(secret)) {
      this.noteFailure(ip);
      return this.json(res, 401, { error: "code d'association invalide ou déjà utilisé" });
    }
    // Someone who presents a good secret is not a guesser: their budget starts over.
    this.attempts.delete(ip);
    const name =
      String(body.name ?? "Téléphone")
        .trim()
        .slice(0, 60) || "Téléphone";
    const token = randomBytes(32).toString("base64url");
    const device = {
      deviceId: randomBytes(8).toString("hex"),
      name,
      // Kept as a hash: what the phone holds is never written down here.
      tokenHash: hashToken(token),
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    };
    const cfg = this.core.settings.getAll();
    this.core.settings.set("mobile", { ...cfg.mobile, devices: [...cfg.mobile.devices, device] });
    this.core.notifications.add("success", "Téléphone associé", `${device.name} peut maintenant parler à Jarod-One.`);
    return this.json(res, 200, { token, device: { deviceId: device.deviceId, name: device.name } });
  }

  /** Answers a phone's message. The phone cannot approve a tool call, so dangerous ones are refused. */
  private ask(sessionId: string, text: string): void {
    const hooks: AgentHooks = {
      emit: (event) => this.push(event),
      approve: async () => false,
    };
    void this.core.runAndWait(sessionId, text, hooks).catch((e: unknown) => {
      this.push({ type: "error", sessionId, error: (e as Error).message });
      this.push({ type: "done", sessionId });
    });
  }

  private push(event: AgentEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.streams) {
      if (stream.sessionId && event.sessionId && stream.sessionId !== event.sessionId) continue;
      stream.res.write(data);
    }
  }

  /** Opens the window for an address, without spending anything on it. */
  private mayTry(ip: string): boolean {
    const seen = this.attempts.get(ip);
    return !seen || seen.until < Date.now() || seen.count < PAIR_ATTEMPTS;
  }

  /** Only a failure counts: a successful pairing must not bring anyone closer to the limit. */
  private noteFailure(ip: string): void {
    const now = Date.now();
    const seen = this.attempts.get(ip);
    if (!seen || seen.until < now) this.attempts.set(ip, { count: 1, until: now + PAIR_WINDOW_MS });
    else seen.count += 1;
  }

  private device(req: IncomingMessage, url: URL): { deviceId: string; name: string } | null {
    // A browser's EventSource cannot carry a header, so the token is also accepted in the query.
    const header = req.headers.authorization ?? "";
    const raw = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("t") ?? "");
    if (!raw) return null;
    const hash = hashToken(raw);
    const cfg = this.core.settings.getAll();
    const device = cfg.mobile.devices.find((d) => safeEqual(d.tokenHash, hash));
    if (!device) return null;
    if (Date.now() - device.lastSeen > TOUCH_MS) {
      this.core.settings.set("mobile", {
        ...cfg.mobile,
        devices: cfg.mobile.devices.map((d) => (d === device ? { ...d, lastSeen: Date.now() } : d)),
      });
    }
    return { deviceId: device.deviceId, name: device.name };
  }

  private dropDevice(deviceId: string): void {
    const cfg = this.core.settings.getAll();
    this.core.settings.set("mobile", {
      ...cfg.mobile,
      devices: cfg.mobile.devices.filter((d) => d.deviceId !== deviceId),
    });
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error("corps trop volumineux");
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return;
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(payload);
  }

  private html(res: ServerResponse, page: string): void {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // The page is served here and loads one script from here; nothing else is allowed.
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:",
    });
    res.end(page);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
