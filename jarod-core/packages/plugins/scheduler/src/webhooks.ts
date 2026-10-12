// Portage de packages/core/src/services/webhooks.ts (rév. 2e180305).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Db } from "@jarod/plugin-storage";
import type { Router } from "@jarod/plugin-llm";
import { DEFAULT_HOOK_PORT } from "@jarod/contracts";
export { DEFAULT_HOOK_PORT };

/**
 * Le plafond de charge utile : au-delà, on refuse au lieu de lire indéfiniment.
 */
export const MAX_PAYLOAD_BYTES = 256 * 1024;
// DEFAULT_HOOK_PORT : déplacé dans @jarod/contracts (ré-exporté ci-dessous).

/**
 * L'identifiant d'un déclencheur déclaré : un sous-ensemble STRICT du motif que la route sait servir
 * (`/^\/hook\/([\w.-]+)$/`, plus bas). Tout identifiant accepté ici est donc joignable — l'inverse
 * serait une porte qu'on croit avoir ouverte et que le serveur ne sert jamais. Une longueur bornée
 * parce que l'identifiant devient une clé de la table `secrets` et un segment d'URL : ni l'un ni
 * l'autre n'a besoin d'un roman.
 */
export const HOOK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface HookRecord {
  at: number;
  hookId: string;
  accepted: boolean;
  reason?: string;
  bytes: number;
}

export interface WebhookStatus {
  running: boolean;
  port: number;
  hooks: string[];
  journal: HookRecord[];
}

/** Un déclencheur tel qu'un écran le montre : son identifiant, et l'adresse à donner à l'émetteur. */
export interface WebhookHookView {
  id: string;
  url: string;
}

/**
 * L'état des déclencheurs, vu par un écran. Il ne porte **aucun secret** : le secret sert à signer
 * côté émetteur, et il n'est rendu que par une demande explicite (`WebhookService.secret`).
 */
export interface WebhooksView {
  /** Le réglage : ces déclencheurs doivent-ils écouter ? Faux par défaut. */
  enabled: boolean;
  /** Vrai quand le serveur d'écoute est réellement ouvert. */
  running: boolean;
  /** Le port EFFECTIF : celui qu'on écoute, ou celui qu'on prendrait si on était activé. */
  port: number;
  hooks: WebhookHookView[];
  journal: HookRecord[];
}

/**
 * L'adresse d'un déclencheur sur un port donné — elle ne contient **aucun secret**, et c'est le seul
 * endroit où cette adresse se fabrique : `WebhookService.url` s'en sert, donc l'écran et le service
 * ne peuvent pas annoncer deux adresses différentes.
 */
export function hookUrl(hookId: string, port: number): string {
  return `http://127.0.0.1:${port}/hook/${hookId}`;
}

/**
 * Le port d'écoute RETENU : un entier dans les bornes d'un port TCP, sinon le port par défaut. Un
 * réglage qui ne désigne pas un port réel (chaîne, zéro, négatif, au-delà de 65535) ne fait pas
 * échouer l'ouverture avec une erreur de socket : il retombe sur le défaut, comme le reste du cœur.
 */
export function normalizeHookPort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return DEFAULT_HOOK_PORT;
  }
  return value;
}

/**
 * Des déclencheurs entrants, signés.
 *
 * Sans eux, l'agent ne peut être réveillé que de l'intérieur : un horaire, ou quelqu'un qui parle.
 * Un morceau d'API, un cron système ou un autre outil ne peuvent rien lui demander.
 *
 * Trois règles, et chacune répond à une façon de se faire avoir. La signature est un HMAC-SHA256 du
 * corps, comparé en **temps constant** — une comparaison qui s'arrête au premier octet différent
 * raconte à l'attaquant combien d'octets il a déjà trouvés. Le secret vit dans la table chiffrée
 * `secrets`, jamais dans les réglages, qui s'exportent. Et le journal garde les **refus** autant que
 * les succès : une requête refusée est une requête qui a eu lieu, et une porte qui ne dit que ses
 * entrées ne dit rien.
 */
export class WebhookService {
  constructor(
    private readonly d: {
      db: Db;
      /** Ce qui se passe pour une requête acceptée. Ici : une exécution mise en file durable. */
      onHook: (hookId: string, payload: unknown, raw: string) => void | Promise<void>;
      port?: number;
      /** Pour les tests : le gestionnaire qui répond, si on ne veut pas de vrai serveur. */
      listen?: (port: number) => Promise<{ port: number; close: () => Promise<void> }>;
      /** Les routes de plugin : le même serveur les sert, plutôt qu'un second port à défendre. */
      router?: Router;
    },
  ) {}

  private server: Server | null = null;
  /**
   * Le gestionnaire d'écoute INJECTÉ (`d.listen`, réservé aux tests) : il se referme par une
   * PROMESSE, pas par le rappel d'un `http.Server`. Le garder à côté du serveur est ce qui fait que
   * `stop()` le referme vraiment — `server.close(rappel)` sur un objet sans rappel n'appellerait
   * jamais le rappel, et la fermeture attendrait indéfiniment.
   */
  private injected: (() => Promise<void>) | null = null;
  private records: HookRecord[] = [];
  private boundPort = 0;
  /** Requêtes acceptées par déclencheur, pour la limite de débit (SPECS-P5-WEBHOOKS § 2.3). */
  private rateLimit = new Map<string, number[]>();
  private static readonly RATE_LIMIT_WINDOW_MS = 60_000;
  private static readonly RATE_LIMIT_MAX = 30;

  /** Le secret d'un déclencheur. Il est **créé** ici s'il n'existe pas, et jamais rendu deux fois. */
  secret(hookId: string, rotate = false): string {
    const key = `webhook.${hookId}`;
    const existing = rotate
      ? undefined
      : this.d.db.get<{ value: string }>("SELECT value FROM secrets WHERE key = ?", key);
    if (existing?.value) return existing.value;
    const secret = randomBytes(32).toString("hex");
    this.d.db.run("INSERT OR REPLACE INTO secrets (key, value) VALUES (?, ?)", key, secret);
    return secret;
  }

  /** Les déclencheurs connus : ceux qui ont un secret en base, et rien d'autre à tenir à jour. */
  hooks(): string[] {
    return this.d.db
      .all<{ key: string }>("SELECT key FROM secrets WHERE key LIKE 'webhook.%'")
      .map((row) => row.key.replace("webhook.", ""));
  }

  remove(hookId: string): void {
    this.d.db.run("DELETE FROM secrets WHERE key = ?", `webhook.${hookId}`);
  }

  async start(port = this.d.port ?? DEFAULT_HOOK_PORT): Promise<WebhookStatus> {
    if (this.server || this.injected) return this.status();
    if (this.d.listen) {
      const bound = await this.d.listen(port);
      this.boundPort = bound.port;
      this.injected = bound.close;
      return this.status();
    }
    const server = createServer((req, res) => void this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        // 127.0.0.1 : ces routes ne doivent jamais être joignables depuis le réseau.
        server.listen(port, "127.0.0.1", () => resolve());
      });
    } catch (e) {
      // Port occupé : erreur dite, jamais un crash (SPECS-P5-WEBHOOKS § 2.1, WS3).
      // Le noyau continue, le service reste simplement non démarré.
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
        return this.status();
      }
      throw e;
    }
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : port;
    this.server = server;
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    const closed = this.injected;
    this.server = null;
    this.injected = null;
    // Le cas injecté d'abord : sa fermeture est une promesse, pas un rappel.
    if (closed) {
      await closed();
      return;
    }
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): WebhookStatus {
    return {
      running: Boolean(this.server || this.injected),
      port: this.boundPort,
      hooks: this.hooks(),
      journal: this.journal(20),
    };
  }

  journal(limit = 50): HookRecord[] {
    return this.records.slice(-limit);
  }

  /** L'adresse à donner à qui doit déclencher : elle ne contient aucun secret. */
  url(hookId: string): string {
    // Le port EFFECTIF d'abord (celui qu'on écoute), sinon le port déclaré, sinon le défaut : la
    // fabrication de l'adresse vit dans `hookUrl`, donc l'écran et le service disent la même chose.
    return hookUrl(hookId, this.boundPort || this.d.port || DEFAULT_HOOK_PORT);
  }

  private record(entry: HookRecord): void {
    this.records.push(entry);
    // Le journal est borné : il informe, il n'archive pas.
    if (this.records.length > 200) this.records = this.records.slice(-200);
  }

  /**
   * Vérifie la limite de débit pour un déclencheur (SPECS-P5-WEBHOOKS § 2.3).
   * Au-delà de 30 requêtes ACCEPTÉES par minute et par déclencheur, refuse 429.
   */
  private checkRateLimit(hookId: string): boolean {
    const now = Date.now();
    const window = WebhookService.RATE_LIMIT_WINDOW_MS;
    const max = WebhookService.RATE_LIMIT_MAX;
    const timestamps = (this.rateLimit.get(hookId) ?? []).filter((t) => now - t < window);
    if (timestamps.length >= max) {
      this.rateLimit.set(hookId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.rateLimit.set(hookId, timestamps);
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const match = /^\/hook\/([\w.-]+)$/.exec(url);
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!match) {
      // Ce n'est pas un déclencheur : c'est peut-être une route de plugin. Un seul serveur, une
      // seule surface sur 127.0.0.1 — deux ports seraient deux choses à sécuriser.
      const router = this.d.router;
      if (!router) return answer(404, { error: "not_found" });
      // Une route de plugin n'a pas de signature : 127.0.0.1 est sa seule barrière, et un navigateur
      // la franchit — toute page visitée peut y envoyer une requête (CSRF), et un nom de domaine
      // qui se résout soudain en 127.0.0.1 peut même lire la réponse (DNS rebinding). Ces routes
      // servent des outils locaux (scripts, curl), jamais une page web : ce qui vient d'un navigateur
      // est refusé, et l'hôte demandé doit être la boucle locale elle-même.
      const refus = browserRefusal(req);
      if (refus) return answer(403, { error: refus });
      const body = await readBody(req, MAX_PAYLOAD_BYTES);
      const query: Record<string, string> = {};
      for (const [key, value] of new URL(url, "http://127.0.0.1").searchParams) query[key] = value;
      const reply = await router.handle({
        method: req.method ?? "GET",
        path: url.split("?")[0] ?? url,
        params: {},
        query,
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        body,
      });
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
      return;
    }
    if (req.method !== "POST") return answer(404, { error: "not_found" });
    const hookId = match[1] as string;

    const chunks: Buffer[] = [];
    let size = 0;
    let refused: string | undefined;
    await new Promise<void>((resolve) => {
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PAYLOAD_BYTES) {
          refused = "charge utile trop grande";
          chunks.length = 0;
          // On arrête de lire, mais on ne coupe pas encore : une connexion tuée avant la réponse
          // ferait échouer le client sur une erreur réseau au lieu de lui montrer le refus.
          req.pause();
          resolve();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", () => resolve());
    });

    if (refused) {
      this.record({ at: Date.now(), hookId, accepted: false, reason: refused, bytes: size });
      answer(413, { error: "payload_too_large" });
      // Maintenant que le refus est parti, la connexion peut être coupée.
      setImmediate(() => req.destroy());
      return;
    }

    const known = this.hooks();
    if (!known.includes(hookId)) {
      this.record({ at: Date.now(), hookId, accepted: false, reason: "déclencheur inconnu", bytes: size });
      return answer(404, { error: "unknown_hook" });
    }

    const raw = Buffer.concat(chunks).toString("utf8");
    const provided = String(req.headers["x-jarod-signature"] ?? "");
    if (!verify(provided, raw, this.secret(hookId))) {
      this.record({ at: Date.now(), hookId, accepted: false, reason: "signature invalide", bytes: size });
      return answer(401, { error: "bad_signature" });
    }

    // Limite de débit : 30 requêtes ACCEPTÉES par minute et par déclencheur (§ 2.3).
    // On compte uniquement les requêtes qui ont passé la signature.
    if (!this.checkRateLimit(hookId)) {
      this.record({ at: Date.now(), hookId, accepted: false, reason: "limite de débit dépassée", bytes: size });
      return answer(429, { error: "rate_limit_exceeded" });
    }

    let payload: unknown = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      this.record({ at: Date.now(), hookId, accepted: false, reason: "JSON illisible", bytes: size });
      return answer(400, { error: "bad_json" });
    }

    this.record({ at: Date.now(), hookId, accepted: true, bytes: size });
    answer(202, { accepted: true });
    // Répondre d'abord, exécuter ensuite : celui qui déclenche ne doit pas attendre un agent.
    await this.d.onHook(hookId, payload, raw);
  }
}

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Pourquoi une requête vers une route de plugin vient (ou peut venir) d'une page web, ou null. Un
 * navigateur envoie `Origin` sur tout ce qui n'est pas une simple navigation, et `Sec-Fetch-Site` sur
 * tout ; un outil local n'envoie ni l'un ni l'autre (ou `none`).
 */
export function browserRefusal(req: Pick<IncomingMessage, "headers">): string | null {
  const host = String(req.headers.host ?? "");
  if (!LOOPBACK_HOST.test(host)) return "host_not_loopback";
  if (req.headers.origin !== undefined) return "browser_origin";
  // `none` : l'adresse tapée à la main. Même `same-origin` est refusé — une route qui rendrait du
  // HTML ferait de cette origine une page, et ses requêtes passeraient pour les nôtres.
  if (String(req.headers["sec-fetch-site"] ?? "none") !== "none") return "browser_cross_site";
  return null;
}

/** Lit un corps borné, et le dit quand il dépasse — sans jamais le lire en entier. */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve());
    req.on("error", () => resolve());
  });
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Compare une signature à celle qu'on calcule. Les deux tampons ont la même longueur par
 * construction, et la comparaison ne s'arrête pas au premier octet différent.
 */
export function verify(provided: string, body: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const given = provided.replace(/^sha256=/i, "").toLowerCase();
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Ce qu'un appelant doit envoyer, pour ne pas laisser deviner le format. */
export function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}
