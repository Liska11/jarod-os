/**
 * E2 — lecture PONCTUELLE dans Firefox par une extension (voir docs/E2-FIREFOX-READER-PLAN.md). Désactivé, non branché à l'application.
 *
 * Deux pièces :
 *  - `ReaderChannel` : le canal avec l'extension. HTTP sur le bouclage en interrogation longue, ouvert seulement pendant un essai, UN client, défi-réponse HMAC
 *    (la clé d'appairage ne circule jamais), en-têtes `Host` (bouclage) et `Origin` (`moz-extension://`) contrôlés, corps bornés, débit borné.
 *    Une page web n'a ni la clé ni la bonne origine : elle ne peut ni parler au canal ni faire lire quoi que ce soit.
 *  - `FirefoxReader` : le courtier. Il reçoit la SÉLECTION faite par le geste de l'utilisateur dans l'extension (onglet, document, origine : jamais de
 *    contenu), applique la politique de domaines, demande l'accord central pour CETTE lecture, puis commande la lecture au moment de l'accord et
 *    revérifie tout au retour. Le résultat va à un affichage LOCAL ; le journal ne garde que l'opération, l'hôte, le résultat et le motif.
 *
 * Ce que cette voie ne fournit PAS : le confinement réseau du Chrome jetable. Elle limite ce que JAROD-OS peut LIRE ; elle ne filtre rien du trafic de Firefox.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { AdapterRefused } from "./common.js";
import { type BrowserPolicy, hostOf, hostPermitted } from "./browser.js";

const A = "E2";

/** Un message du canal : un objet JSON dont le champ `type` est une chaîne. */
export type ChannelMessage = { type: string } & Record<string, unknown>;

export interface ReaderChannelOptions {
  /** Taille d'un message ou d'un corps de requête (défaut 64 Ko). */
  maxMessage?: number;
  /** Échecs d'authentification avant verrouillage (défaut 3). */
  maxFailures?: number;
  /** Durée du verrouillage (défaut 60 s). */
  lockMs?: number;
  /** Requêtes par seconde au plus (défaut 20). */
  maxPerSecond?: number;
  /** Durée d'une attente de commandes (interrogation longue ; défaut 20 s). */
  pollMs?: number;
  /** Sans aucune requête de l'extension pendant cette durée, la session est terminée (défaut 30 s). */
  idleMs?: number;
  now?: () => number;
}

/**
 * Le canal est du HTTP sur le bouclage, en interrogation longue (et non un WebSocket : Firefox récent « met à niveau » ws:// en wss:// même vers 127.0.0.1, mesuré
 * le 2026-10-17, code 1015, alors que fetch vers http://127.0.0.1 passe). Chaque requête doit venir d'une extension (`Origin: moz-extension://…`) et porter, hors
 * ouverture de session, le jeton de session obtenu par défi-réponse HMAC.
 */
export class ReaderChannel {
  private server: Server | null = null;
  private key = Buffer.alloc(0);
  private port = 0;
  private failures = 0;
  private lockedUntil = 0;
  private challenge: { nonce: string; at: number } | null = null;
  private session: { token: Buffer; lastSeen: number; window: { start: number; count: number } } | null = null;
  private queue: ChannelMessage[] = [];
  private waiter: { res: ServerResponse; timer: ReturnType<typeof setTimeout>; origin: string } | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private onMessage: (m: ChannelMessage) => void = () => undefined;
  private onClosed: () => void = () => undefined;
  private readonly max: number;
  private readonly now: () => number;

  constructor(private readonly o: ReaderChannelOptions = {}) {
    this.max = o.maxMessage ?? 64 * 1024;
    this.now = o.now ?? Date.now;
  }

  /** Les gestionnaires : `message` ne reçoit que des messages APRÈS authentification. */
  handlers(h: { message(m: ChannelMessage): void; closed(): void }): void {
    this.onMessage = h.message;
    this.onClosed = h.closed;
  }

  get connected(): boolean {
    return this.session !== null;
  }

  /** Ouvre le canal et rend le code d'appairage (« jarod1.<port>.<64 hex> ») à coller dans l'extension. Une clé NEUVE à chaque ouverture. */
  async start(): Promise<{ port: number; pairingCode: string }> {
    if (this.server) throw new AdapterRefused(A, "canal déjà ouvert");
    this.key = randomBytes(32);
    this.failures = 0;
    this.lockedUntil = 0;
    const server = createServer((req, res) => this.handle(req, res));
    server.on("upgrade", (_req, socket) => (socket as Duplex).destroy()); // pas de WebSocket ici
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    this.idleTimer = setInterval(() => {
      const s = this.session;
      if (s && this.now() - s.lastSeen > (this.o.idleMs ?? 30_000)) this.endSession();
    }, 250);
    this.idleTimer.unref();
    return { port: this.port, pairingCode: `jarod1.${this.port}.${this.key.toString("hex")}` };
  }

  private reply(res: ServerResponse, origin: string, status: number, body?: unknown): void {
    const headers: Record<string, string> = { "cache-control": "no-store", "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST", "access-control-max-age": "60" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (!res.headersSent) res.writeHead(status, headers);
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private fail(): void {
    if (++this.failures >= (this.o.maxFailures ?? 3)) this.lockedUntil = this.now() + (this.o.lockMs ?? 60_000);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const h = req.headers;
    const origin = String(h.origin ?? "");
    const deny = (status: number) => {
      res.writeHead(status, { "cache-control": "no-store" });
      res.end();
    };
    // Une page web n'a ni la bonne origine ni (surtout) la clé : on ne lui répond même pas par un en-tête CORS.
    if (!origin.startsWith("moz-extension://")) return deny(403);
    const host = String(h.host ?? "");
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return deny(403);
    if (req.method === "OPTIONS") return this.reply(res, origin, 204);
    if (req.method !== "POST") return deny(405);
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/hello" && path !== "/auth" && path !== "/msg" && path !== "/poll" && path !== "/bye") return deny(404);
    const type = String(h["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return deny(415);
    if (this.now() < this.lockedUntil) return deny(429);
    let size = 0;
    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > this.max) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) return this.reply(res, origin, 413);
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return this.reply(res, origin, 400);
        body = parsed as Record<string, unknown>;
      } catch {
        return this.reply(res, origin, 400);
      }
      if (path === "/hello") return this.hello(res, origin);
      if (path === "/auth") return this.auth(res, origin, body);
      this.authorized(req, res, origin, path === "/msg" ? () => this.msg(res, origin, body) : path === "/bye" ? () => (this.reply(res, origin, 200, { ok: true }), this.endSession()) : () => this.poll(res, origin));
    });
  }

  private hello(res: ServerResponse, origin: string): void {
    if (this.session) return this.reply(res, origin, 409); // un seul client à la fois
    this.challenge = { nonce: randomBytes(16).toString("hex"), at: this.now() };
    this.reply(res, origin, 200, { nonce: this.challenge.nonce });
  }

  private auth(res: ServerResponse, origin: string, body: Record<string, unknown>): void {
    const c = this.challenge;
    this.challenge = null; // un défi ne sert qu'une fois
    if (this.session) return this.reply(res, origin, 409);
    const expected = c && this.now() - c.at < 10_000 ? createHmac("sha256", this.key).update(c.nonce).digest() : null;
    const given = typeof body.proof === "string" && /^[0-9a-f]{64}$/.test(body.proof) ? Buffer.from(body.proof, "hex") : Buffer.alloc(0);
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.fail();
      return this.reply(res, origin, 403);
    }
    this.failures = 0;
    const token = randomBytes(16);
    this.session = { token, lastSeen: this.now(), window: { start: this.now(), count: 0 } };
    this.queue = [];
    this.reply(res, origin, 200, { session: token.toString("hex") });
  }

  private authorized(req: IncomingMessage, res: ServerResponse, origin: string, run: () => void): void {
    const s = this.session;
    const m = /^Bearer ([0-9a-f]{32})$/.exec(String(req.headers.authorization ?? ""));
    if (!s || !m || !timingSafeEqual(Buffer.from(m[1]!, "hex"), s.token)) {
      this.fail();
      return this.reply(res, origin, 401);
    }
    const t = this.now();
    s.lastSeen = t;
    if (t - s.window.start >= 1000) s.window = { start: t, count: 0 };
    if (++s.window.count > (this.o.maxPerSecond ?? 20)) {
      this.endSession();
      return this.reply(res, origin, 429);
    }
    run();
  }

  private msg(res: ServerResponse, origin: string, body: Record<string, unknown>): void {
    if (typeof body.type !== "string") return this.reply(res, origin, 400);
    this.reply(res, origin, 200, { ok: true });
    this.onMessage(body as ChannelMessage);
  }

  private poll(res: ServerResponse, origin: string): void {
    this.flushWaiter(); // une seule interrogation en cours : la précédente reçoit une réponse vide
    if (this.queue.length) return this.reply(res, origin, 200, { messages: this.queue.splice(0) });
    const timer = setTimeout(() => this.flushWaiter(), this.o.pollMs ?? 20_000);
    this.waiter = { res, timer, origin };
    res.on("close", () => {
      if (this.waiter?.res === res) {
        clearTimeout(timer);
        this.waiter = null;
      }
    });
  }

  private flushWaiter(): void {
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    clearTimeout(w.timer);
    this.reply(w.res, w.origin, 200, { messages: this.queue.splice(0) });
  }

  private endSession(): void {
    const had = this.session !== null;
    this.session = null;
    this.challenge = null;
    this.queue = [];
    this.flushWaiter();
    if (had) this.onClosed();
  }

  /** Envoie un message à l'extension (à sa prochaine interrogation, ou tout de suite si elle attend) ; faux s'il n'y en a pas. */
  send(m: ChannelMessage): boolean {
    if (!this.session) return false;
    if (JSON.stringify(m).length > this.max) return false;
    this.queue.push(m);
    this.flushWaiter();
    return true;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.endSession();
    const s = this.server;
    this.server = null;
    this.key = Buffer.alloc(0);
    if (s) await new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())));
  }
}

// ── le courtier ────────────────────────────────────────────────────────────────────────────────────────────

/** Ce que l'utilisateur voit AVANT d'accorder la lecture. */
export interface ReaderApprovalRequest {
  op: "read_element";
  browser: "Firefox";
  host: string;
  /** Origine + chemin, sans requête ni fragment. */
  url: string;
  params: { selector: string; scope: string; tab: number };
  summary: string;
}

export interface ReaderAuditEntry {
  op: "read_element";
  host?: string;
  ok: boolean;
  reason?: string;
}

/** Ce qui est affiché LOCALEMENT après une lecture accordée. Rien d'autre n'en sort : ni journal, ni modèle. */
export interface ReaderDisplay {
  host: string;
  url: string;
  title: string;
  text: string;
}

export interface FirefoxReaderDeps {
  channel: ReaderChannel;
  policy: BrowserPolicy;
  /** L'accord central. Absent, refusé, en erreur ou trop lent = aucune lecture. */
  approve?: (request: ReaderApprovalRequest, caller?: unknown) => Promise<boolean>;
  display: (r: ReaderDisplay) => void;
  audit?: (e: ReaderAuditEntry) => void;
  /** Délai de l'accord (défaut 120 s). */
  approvalTimeoutMs?: number;
  /** Durée de vie de l'accord, de l'accord à la lecture (défaut 20 s). */
  readTtlMs?: number;
  /** Durée pendant laquelle un geste reste une cible (défaut 5 min). */
  selectionTtlMs?: number;
  perMinute?: number;
  now?: () => number;
}

interface Selection {
  id: string;
  tabId: number;
  docId: string;
  origin: string;
  url: string;
  at: number;
}

const SELECTOR = /^(?:[a-z][a-z0-9-]*)?(?:#[A-Za-z][\w-]*)?(?:\.[A-Za-z][\w-]*)*$/;
const ORIGIN = /^https?:\/\/[^/?#\s]+$/;
const DOC_ID = /^[0-9a-f-]{36}$/;
const SEL_ID = /^[0-9a-f-]{36}$/;

export class FirefoxReader {
  private current: Selection | null = null;
  private pending: { id: string; ticket: string; settle: (r: ChannelMessage | Error) => void } | null = null;
  private readonly calls: number[] = [];
  private readonly now: () => number;

  constructor(private readonly d: FirefoxReaderDeps) {
    this.now = d.now ?? Date.now;
    d.channel.handlers({
      message: (m) => this.onMessage(m),
      closed: () => this.invalidate(null, "canal fermé"),
    });
  }

  /** Le geste le plus récent, sans contenu : pour l'afficher à l'utilisateur et lui faire confirmer la cible. */
  selection(): { tabId: number; origin: string; url: string; ageMs: number } | null {
    const s = this.fresh();
    return s ? { tabId: s.tabId, origin: s.origin, url: s.url, ageMs: this.now() - s.at } : null;
  }

  private fresh(): Selection | null {
    const s = this.current;
    if (!s) return null;
    if (this.now() - s.at > (this.d.selectionTtlMs ?? 5 * 60_000)) {
      this.current = null;
      return null;
    }
    return s;
  }

  private onMessage(m: ChannelMessage): void {
    if (m.type === "select") {
      const ok =
        typeof m.id === "string" && SEL_ID.test(m.id) && Number.isInteger(m.tabId) && typeof m.docId === "string" && DOC_ID.test(m.docId) &&
        typeof m.origin === "string" && ORIGIN.test(m.origin) && typeof m.url === "string" && m.url.startsWith(m.origin) && m.url.length <= 2048 && !/[?#]/.test(m.url);
      this.invalidate(null, "nouveau geste"); // un nouveau geste annule toute attente en cours
      if (ok) this.current = { id: m.id as string, tabId: m.tabId as number, docId: m.docId as string, origin: m.origin as string, url: m.url as string, at: this.now() };
    } else if (m.type === "invalidate") {
      this.invalidate(typeof m.id === "string" ? m.id : null, typeof m.why === "string" ? m.why.slice(0, 80) : "invalidée");
    } else if (m.type === "result") {
      const p = this.pending;
      if (p && m.id === p.id && m.ticket === p.ticket) p.settle(m);
      // un résultat sans attente, d'un autre identifiant ou d'un autre ticket est ignoré
    }
  }

  private invalidate(id: string | null, why: string): void {
    const s = this.current;
    if (s && (id === null || s.id === id)) this.current = null;
    const p = this.pending;
    if (p && (id === null || p.id === id)) p.settle(new AdapterRefused(A, `lecture annulée : ${why}`));
  }

  private rate(): void {
    const t = this.now();
    while (this.calls.length && t - this.calls[0]! > 60_000) this.calls.shift();
    if (this.calls.length >= (this.d.perMinute ?? 6)) throw new AdapterRefused(A, "trop de lectures à la minute");
    this.calls.push(t);
  }

  private async ask(request: ReaderApprovalRequest, caller: unknown): Promise<void> {
    const approve = this.d.approve;
    if (!approve) throw new AdapterRefused(A, "lecture non accordée");
    const limit = this.d.approvalTimeoutMs ?? 120_000;
    const asked = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((r) => (timer = setTimeout(() => r("expired"), limit)));
    let answer: boolean | "expired";
    try {
      answer = await Promise.race([approve(request, caller).then((v) => v === true), expired]);
    } catch {
      answer = false;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (answer === "expired" || this.now() - asked > limit) throw new AdapterRefused(A, "accord expiré : lecture non faite");
    if (answer !== true) throw new AdapterRefused(A, "lecture non accordée");
  }

  /**
   * Lit le titre et le texte de l'élément convenu (`selector`, simple) dans l'onglet que l'utilisateur a désigné par son geste. Le résultat va à
   * `display` ; la promesse ne rend rien (le contenu ne circule pas dans la valeur de retour, donc ni vers un modèle, ni vers un journal).
   */
  async readElement(selector: string, caller?: unknown): Promise<void> {
    let host: string | undefined;
    try {
      if (typeof selector !== "string" || selector.length === 0 || selector.length > 80 || !SELECTOR.test(selector)) throw new AdapterRefused(A, "sélecteur non simple (identifiant, classe ou balise seulement)");
      const sel = this.fresh();
      if (!sel) throw new AdapterRefused(A, "aucune cible : cliquez sur le bouton de l'extension dans l'onglet voulu");
      host = hostOf(sel.origin); // refuse tout autre schéma que http(s)
      if (!hostPermitted(host, this.d.policy)) throw new AdapterRefused(A, "domaine hors de la politique (interdit ou non permis)");
      this.rate();
      const key = JSON.stringify({ id: sel.id, tab: sel.tabId, doc: sel.docId, origin: sel.origin, selector });
      const request: ReaderApprovalRequest = {
        op: "read_element",
        browser: "Firefox",
        host,
        url: sel.url,
        params: { selector, scope: "titre de la page et texte de cet élément seulement", tab: sel.tabId },
        summary: `Firefox : lire le titre et le texte de « ${selector} » sur ${host} (${sel.url})`,
      };
      await this.ask(request, caller);
      // L'accord vaut pour CETTE lecture : la cible doit être exactement la même qu'au moment de la demande.
      const again = this.fresh();
      if (!again || JSON.stringify({ id: again.id, tab: again.tabId, doc: again.docId, origin: again.origin, selector }) !== key) throw new AdapterRefused(A, "la cible a changé depuis l'accord : rien n'est lu, nouvel accord nécessaire");
      const ticket = randomBytes(16).toString("hex");
      const ttl = this.d.readTtlMs ?? 20_000;
      const expiresAt = this.now() + ttl;
      const result = await new Promise<ChannelMessage | Error>((resolve) => {
        const timer = setTimeout(() => finish(new AdapterRefused(A, "accord expiré avant la lecture")), ttl);
        const finish = (r: ChannelMessage | Error) => {
          clearTimeout(timer);
          if (this.pending && this.pending.ticket === ticket) this.pending = null;
          resolve(r);
        };
        this.pending = { id: sel.id, ticket, settle: finish };
        const sent = this.d.channel.send({ type: "read", id: sel.id, tabId: sel.tabId, docId: sel.docId, origin: sel.origin, selector, expiresAt, ticket });
        if (!sent) finish(new AdapterRefused(A, "extension non connectée"));
      });
      if (result instanceof Error) throw result;
      // Retour : même cible, accord non expiré, usage unique ; sinon ce qui est revenu est jeté sans être regardé.
      const last = this.current;
      if (this.now() > expiresAt) throw new AdapterRefused(A, "accord expiré avant la lecture");
      if (last && last.id !== sel.id) throw new AdapterRefused(A, "la cible a changé pendant la lecture");
      if (result.ok !== true) throw new AdapterRefused(A, `lecture refusée par l'extension : ${typeof result.reason === "string" ? result.reason.slice(0, 80) : "motif absent"}`);
      const title = typeof result.title === "string" ? result.title.slice(0, 200) : "";
      const text = typeof result.text === "string" ? result.text.slice(0, 500) : "";
      this.current = null; // une lecture par geste
      this.d.display({ host, url: sel.url, title, text });
      this.d.audit?.({ op: "read_element", host, ok: true });
    } catch (e) {
      this.d.audit?.({ op: "read_element", ...(host ? { host } : {}), ok: false, reason: (e as Error).message.slice(0, 120) });
      throw e;
    }
  }

  async stop(): Promise<void> {
    this.invalidate(null, "arrêt");
    await this.d.channel.close();
  }
}
