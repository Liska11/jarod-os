// Serveur Hugging Face FACTICE, local (127.0.0.1, port éphémère) — SPECS-P5-MODELS.md § 6. Routes : `resolve/<sha>/<fichier>` et un « CDN » (chantier 1), recherche et
// fiche (chantier 2), flux altérés (chantier 3), `tree` paginé, 429 d'API, redirections spéciales (chantier 4). Il reproduit la forme OBSERVÉE le 2026-10-03 (§ 1.4) :
// premier saut 302 SANS 206 vers un CDN à URL pré-signée, 206 + `Content-Range` au CDN, `ETag` du CDN ≠ SHA-256. Il COMPTE chaque requête
// (chemin, `Range`, `Authorization`, statut, octets servis) pour que les tests prouvent ce qui est parti et ce qui n'est pas parti.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const SHA = "9217f5db79a29953eb74d5343926648285ec7e67";

export interface LogEntry {
  /** Chantier 6c : l'instant de réception (`Date.now()`), pour situer la requête par rapport aux gestes d'une page pilotée (e2e). */
  at: number;
  path: string;
  /** Chaîne de requête (`?blobs=true`, `?cursor=…`). */
  search: string;
  range: string | undefined;
  authorization: string | undefined;
  acceptEncoding: string | undefined;
  status: number;
  /** Octets de corps réellement écrits sur la socket (un client qui coupe arrête l'écriture). */
  served: number;
  /** Vrai quand le client a fermé la connexion AVANT la fin de la réponse (annulation, abandon sur dépassement). */
  aborted: boolean;
}

export type RangeMode = "honor" | "ignore" | "wrong-start" | "overlong" | "bad-total" | "short-body" | "no-content-range";

/** Une fiche de dépôt : les champs de la fiche (`sha`, `gated`, `cardData`, `tags`, `gguf`…) sont rendus TELS QUELS, sauf ceux qui pilotent le serveur. */
export interface FakeModel {
  sha?: string;
  gated?: unknown;
  cardData?: unknown;
  tags?: string[];
  gguf?: unknown;
  /** Rendus complets avec `?blobs=true`, réduits à `rfilename` sans (forme R1 / R2 du § 1.4). */
  siblings: unknown[];
  /** `GET …/tree/<rev>` : entrées rendues telles quelles, paginées par `pageSize` avec l'en-tête `Link … rel="next"`. */
  tree?: unknown[];
  pageSize?: number;
  /** Origine écrite dans l'en-tête `Link` (défaut : ce serveur) — un hôte interdit pour tester le contrôle. */
  linkHost?: string;
  /** Corps brut de la fiche (non JSON, trop gros…). */
  raw?: string;
}

export interface FakeHfOptions {
  repo?: string;
  /** Nom de fichier → octets. */
  files: Record<string, Uint8Array>;
  /** Où le premier saut redirige : `"self"` (un chemin /cdn/ de ce serveur, défaut), une origine complète (autre serveur, hôte interdit), `"none"` (sert directement). */
  redirect?: "self" | "none" | string;
  /** Nombre de redirections en chaîne avant de servir (défaut 1 avec `redirect`). */
  chain?: number;
  rangeMode?: RangeMode;
  /** Répond 429 (avec cet en-tête `Retry-After` quand défini) à toute requête de données, ou seulement à `resolve` / au CDN (`at`). */
  rateLimit?: { retryAfter?: string; at?: "resolve" | "cdn" };
  /** Chantier 4 : répond 429 à toute requête de l'API (`/api/…` : recherche, fiche, `tree`). */
  apiRateLimit?: { retryAfter?: string; onlyTree?: boolean };
  /** Chantier 4 : le premier saut redirige SANS en-tête `Location`. */
  noLocation?: boolean;
  /** Chantier 4 : répond 206 + `Content-Range` à une requête SANS `Range` (réponse partielle non demandée). */
  partialOnPlain?: boolean;
  /** Ne répond jamais (test du délai). */
  hang?: boolean;
  /** Vitesse : octets par tranche écrite, puis attente d'un tour de boucle (permet d'annuler en cours). */
  chunk?: number;
  /** `GET /api/models?search=…` : lignes rendues TELLES QUELLES (le test y met des identifiants hostiles). */
  searchRows?: unknown[];
  /** `GET /api/models/<owner>/<repo>` : la fiche (`sha`, `siblings`) rendue telle quelle ; absente = 404. */
  models?: Record<string, FakeModel>;
  /** Chantier 3 : sert SANS `Content-Length` (transfert par morceaux) — un flux court n'est alors signalé par aucun en-tête. */
  chunked?: boolean;
  /** Chantier 3 : annonce la longueur complète, écrit ce nombre d'octets de corps, puis coupe la connexion (réseau qui tombe). */
  cutAfter?: number;
  /** Chantier 3 : inverse un octet au milieu du corps (même taille, SHA-256 différent) — pour tous les fichiers (`true`) ou ceux nommés. */
  corrupt?: boolean | string[];
  /** Chantier 3 : l'`ETag` du CDN (défaut : une empreinte Xet, ≠ SHA-256, § 1.4). */
  etag?: string;
  /**
   * Chantier 5a : l'en-tête `X-Linked-Size` du PREMIER saut (défaut : la longueur réelle du fichier, comme le vrai serveur). `"absent"` = pas d'en-tête ;
   * une chaîne = cette valeur telle quelle, pour tous les fichiers (`"999"`, `"abc"`, `""`…) ; un objet = la valeur de chaque fichier nommé, la longueur réelle pour les autres.
   */
  linkedSize?: "absent" | string | Record<string, string>;
  /** Chantier 5b : attend ce nombre de millisecondes avant de répondre à une requête du « CDN » (lectures qui se chevauchent : pic de simultanéité). */
  holdMs?: number;
  /** Chantier 5b : attend ce nombre de millisecondes après CHAQUE tranche écrite (transfert lent : le temps d'annuler en cours de route). */
  chunkDelayMs?: number;
  /** Chantier 5b : répond ce statut (401, 403…) à toute requête `resolve/` (dépôt « gated »). */
  resolveStatus?: number;
}

export interface FakeHf {
  origin: string;
  host: string;
  log: LogEntry[];
  options: FakeHfOptions;
  /** Chantier 5b : requêtes du « CDN » en cours en même temps, au plus haut. */
  stats: { peakCdnInFlight: number };
  resolveUrl(file: string, sha?: string): string;
  close(): Promise<void>;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export async function startFakeHf(options: FakeHfOptions): Promise<FakeHf> {
  const log: LogEntry[] = [];
  const stats = { peakCdnInFlight: 0 };
  let cdnInFlight = 0;
  const repo = options.repo ?? "acme/tiny-GGUF";
  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", origin);
    const entry: LogEntry = { at: Date.now(), path: url.pathname, search: url.search, range: req.headers.range, authorization: req.headers.authorization, acceptEncoding: req.headers["accept-encoding"], status: 0, served: 0, aborted: false };
    res.on("close", () => {
      if (!res.writableFinished) entry.aborted = true;
    });
    log.push(entry);
    const end = (status: number, headers: Record<string, string | number> = {}, body?: Buffer) => {
      entry.status = status;
      res.writeHead(status, headers);
      entry.served += body?.length ?? 0;
      res.end(body);
    };
    if (options.hang) return; // la socket reste ouverte, rien ne vient
    const seg = url.pathname.split("/").filter(Boolean);
    // API de métadonnées : recherche, fiche (avec ou sans `blobs`), `tree` paginé par `Link`, 429.
    if (seg[0] === "api" && seg[1] === "models") {
      if (options.apiRateLimit && (!options.apiRateLimit.onlyTree || seg[4] === "tree")) return end(429, options.apiRateLimit.retryAfter === undefined ? {} : { "retry-after": options.apiRateLimit.retryAfter }, Buffer.from("rate limited"));
      const jsonHeaders: Record<string, string> = { "content-type": "application/json" };
      const json = (value: unknown, extra: Record<string, string> = {}) => end(200, { ...jsonHeaders, ...extra }, Buffer.from(JSON.stringify(value)));
      if (seg.length === 2) return json(options.searchRows ?? []);
      const repoId = `${seg[2]}/${seg[3]}`;
      const model = options.models?.[repoId];
      if (!model) return end(404, {}, Buffer.from("not found"));
      if (seg[4] === "tree") {
        const entries = model.tree ?? [];
        const size = model.pageSize ?? Math.max(entries.length, 1);
        const cursor = Number(url.searchParams.get("cursor") ?? 0);
        const extra: Record<string, string> = {};
        if (cursor + size < entries.length) extra.link = `<${model.linkHost ?? origin}/api/models/${repoId}/tree/${seg[5]}?recursive=true&cursor=${cursor + size}>; rel="next"`;
        return json(entries.slice(cursor, cursor + size), extra);
      }
      if (model.raw !== undefined) return end(200, jsonHeaders, Buffer.from(model.raw));
      const { siblings, tree: _tree, pageSize: _pageSize, linkHost: _linkHost, raw: _raw, ...fiche } = model;
      const blobs = url.searchParams.get("blobs") === "true";
      return json({ id: repoId, ...fiche, siblings: blobs ? siblings : siblings.map((x) => ({ rfilename: (x as { rfilename?: unknown }).rfilename })) });
    }
    // resolve : /<owner>/<repo>/resolve/<rev>/<fichier…>
    if (seg[2] === "resolve") {
      const file = decodeURIComponent(seg.slice(4).join("/"));
      if (options.resolveStatus !== undefined) return end(options.resolveStatus, { "content-type": "text/plain; charset=utf-8" }, Buffer.from("denied"));
      if (options.rateLimit && options.rateLimit.at !== "cdn") return end(429, options.rateLimit.retryAfter === undefined ? {} : { "retry-after": options.rateLimit.retryAfter }, Buffer.from("rate limited"));
      const mode = options.redirect ?? "self";
      if (mode === "none") return serve(req, res, entry, file);
      const hops = options.chain ?? 1;
      const target = mode === "self" ? origin : mode;
      const first = hops > 1 ? `${origin}/hop/1/${encodeURIComponent(file)}` : `${target}/cdn/xet-bridge/${encodeURIComponent(file)}?Signature=fake&Expires=9999999999`;
      // Le premier saut ne répond PAS 206 (forme observée) : 302 et un petit corps texte.
      if (options.noLocation) return end(302, { "content-type": "text/plain; charset=utf-8" }, Buffer.from("Found. Nowhere."));
      const actual = String(options.files[file]?.length ?? 0);
      const ls = options.linkedSize;
      const linked = ls === "absent" ? undefined : typeof ls === "string" ? ls : (ls?.[file] ?? actual);
      return end(302, { location: first, "content-type": "text/plain; charset=utf-8", ...(linked === undefined ? {} : { "x-linked-size": linked }) }, Buffer.from("Found. Redirecting to cdn"));
    }
    if (seg[0] === "hop") {
      const k = Number(seg[1]);
      const file = decodeURIComponent(seg[2] ?? "");
      const hops = options.chain ?? 1;
      const target = options.redirect === "self" || options.redirect === undefined ? origin : (options.redirect as string);
      const next = k + 1 >= hops ? `${target}/cdn/xet-bridge/${encodeURIComponent(file)}` : `${origin}/hop/${k + 1}/${encodeURIComponent(file)}`;
      return end(302, { location: next }, Buffer.from("hop"));
    }
    if (seg[0] === "cdn") {
      if (options.rateLimit && options.rateLimit.at !== "resolve") return end(429, options.rateLimit.retryAfter === undefined ? {} : { "retry-after": options.rateLimit.retryAfter }, Buffer.from("rate limited"));
      cdnInFlight++;
      stats.peakCdnInFlight = Math.max(stats.peakCdnInFlight, cdnInFlight);
      res.on("close", () => void cdnInFlight--);
      if (options.holdMs) await new Promise((r) => setTimeout(r, options.holdMs));
      return serve(req, res, entry, decodeURIComponent(seg[2] ?? ""));
    }
    return end(404, {}, Buffer.from("not found"));
  }

  async function serve(req: IncomingMessage, res: ServerResponse, entry: LogEntry, file: string): Promise<void> {
    const bytes = options.files[file];
    if (!bytes) {
      entry.status = 404;
      res.writeHead(404).end();
      return;
    }
    const total = bytes.length;
    const mode = options.rangeMode ?? "honor";
    const m = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? "");
    const etag = options.etag ?? '"0663b826e09042345d6e2069d9655cd3ae84812d8f39a5894bed7b24fc0e86cc"'; // empreinte Xet, PAS le SHA-256 (§ 1.4)
    let status = 200;
    let from = 0;
    let to = total - 1;
    const headers: Record<string, string | number> = { "content-type": "application/octet-stream", "accept-ranges": "bytes", etag };
    if (m && mode !== "ignore") {
      from = Number(m[1]);
      to = Math.min(m[2] === undefined ? total - 1 : Number(m[2]), total - 1);
      if (from >= total) {
        entry.status = 416;
        res.writeHead(416, { "content-range": `bytes */${total}` }).end();
        return;
      }
      status = 206;
      let advertisedFrom = from;
      let advertisedTotal = total;
      if (mode === "wrong-start") advertisedFrom = from + 1;
      if (mode === "bad-total") advertisedTotal = total + 1;
      if (mode === "overlong") to = Math.min(to + 10, total - 1);
      if (mode !== "no-content-range") headers["content-range"] = `bytes ${advertisedFrom}-${mode === "overlong" ? to - 10 : to}/${advertisedTotal}`;
    }
    if (!m && options.partialOnPlain) {
      status = 206;
      headers["content-range"] = `bytes 0-${total - 1}/${total}`;
    }
    const slice = Buffer.from(bytes.subarray(from, to + 1));
    if (options.corrupt === true || (Array.isArray(options.corrupt) && options.corrupt.includes(file))) slice[Math.floor(slice.length / 2)]! ^= 0xff;
    const body = mode === "short-body" ? slice.subarray(0, Math.max(0, slice.length - 5)) : slice;
    if (!options.chunked) headers["content-length"] = body.length;
    entry.status = status;
    res.writeHead(status, headers);
    const chunk = options.chunk ?? 64 * 1024;
    const stopAt = options.cutAfter ?? body.length;
    for (let i = 0; i < body.length; i += chunk) {
      if (res.destroyed || res.writableEnded) break;
      if (i >= stopAt) {
        res.destroy(); // la connexion tombe : la longueur annoncée n'est pas tenue
        return;
      }
      const part = body.subarray(i, Math.min(i + chunk, stopAt));
      if (!res.write(part)) {
        await new Promise<void>((r) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            r();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      }
      entry.served += part.length;
      if (options.chunkDelayMs) await new Promise((r) => setTimeout(r, options.chunkDelayMs));
      else await tick();
    }
    if (options.cutAfter !== undefined && stopAt < body.length) {
      res.destroy();
      return;
    }
    if (!res.destroyed) res.end();
  }

  return {
    origin,
    host: `127.0.0.1:${port}`,
    log,
    options,
    stats,
    resolveUrl: (file, sha = SHA) => `${origin}/${repo}/resolve/${sha}/${file.split("/").map(encodeURIComponent).join("/")}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/**
 * Garde-fou : un `fetch` qui échoue sur tout hôte autre que ceux des serveurs factices — un test qui tenterait le vrai réseau est rouge. Compte aussi les
 * appels (`calls`), pour prouver qu'une requête n'est PAS partie.
 */
export function guardedFetch(allowed: readonly string[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.href);
    if (!allowed.includes(url.origin)) return Promise.reject(new Error(`ACCÈS RÉSEAU RÉEL REFUSÉ PAR LE TEST : ${url.origin}`));
    return fetch(input, init);
  }) as typeof fetch;
  return { fetch: guarded, calls };
}
