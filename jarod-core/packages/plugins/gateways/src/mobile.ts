// Portage de packages/core/src/services/mobile.ts (rév. 2e180305).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type { AgentEvent, AgentHooks } from "@jarod/plugin-agent";
import type { GatewayHub } from "./hub.js";
import { MOBILE_APP, MOBILE_PAGE } from "./mobile-page.js";

/** `JarodCore` → les membres publics du hub (`hub.ts`), qui reprend ceux du cœur. */
type JarodCore = Omit<GatewayHub, never>;

const MAX_BODY = 512 * 1024;
/** Failed pairings allowed per address per window. Counting failures, not requests. */
const PAIR_ATTEMPTS = 5;
const PAIR_WINDOW_MS = 10 * 60_000;
/** How often a device's "last seen" is written: every request would rewrite the settings. */
const TOUCH_MS = 60_000;

export interface MobileStatus {
  running: boolean;
  port: number;
  /** What to type on the phone, or "" when this computer has no network address to offer. */
  url: string;
  devices: { deviceId: string; name: string; pairedAt: number; lastSeen: number }[];
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

  constructor(private readonly core: JarodCore) {}

  status(): MobileStatus {
    const cfg = this.core.settings.getAll().mobile;
    const port = this.port();
    return {
      running: this.server !== null,
      port,
      url: this.server ? this.url(port) : "",
      devices: cfg.devices.map(({ deviceId, name, pairedAt, lastSeen }) => ({ deviceId, name, pairedAt, lastSeen })),
    };
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
    if (server) {
      await new Promise<void>((done) => server.close(() => done()));
      this.server = null;
    }
  }

  /** Drops a device, from either side of the app. Its token stops working immediately. */
  revoke(deviceId: string): MobileStatus {
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
