/**
 * Source d'octets HTTP `Range` pour `gguf-fit` (SPECS-P5-MODELS.md § 3.6 et § 3.9) : lit l'EN-TÊTE d'un GGUF distant, jamais le fichier. Une lecture de
 * métadonnées, autorisée sur le geste explicite « Analyser » ; la confirmation précède tout TÉLÉCHARGEMENT (autre chantier).
 *
 * Forme réelle observée le 2026-10-03 (SPECS-P5-MODELS.md § 1.4), reproduite par le serveur factice des tests :
 *  - `GET resolve/<sha>/<fichier>` avec `Range` répond 302 SANS 206, vers un CDN à URL pré-signée ; le `Range` est donc REJOUÉ à chaque saut
 *    (redirections MANUELLES, 3 au plus), et le 206 avec un `Content-Range` cohérent fait foi ;
 *  - le jeton Hugging Face n'est envoyé qu'à l'hôte de base, jamais au CDN ;
 *  - une 429 n'est JAMAIS relancée : l'erreur porte `Retry-After` et c'est l'utilisateur qui relance.
 *
 * Aucun chemin d'écriture : les octets lus ne vont nulle part sauf dans l'analyse en mémoire.
 */
import type { GgufByteSource } from "./gguf-fit.js";
import { HF_BASE_URL, HF_MAX_REDIRECTS, followHfRedirects, isHfUrlAllowed, linkedSizeProblem, parseRetryAfter } from "./hf-fetch.js";

// Le filtrage des hôtes et la lecture de `Retry-After` vivent dans `hf-fetch.ts` (partagés avec le téléchargement) ; ils restent exportés d'ici.
export { HF_BASE_URL, isHfUrlAllowed, parseRetryAfter };

export type GgufRangeErrorCode =
  | "UNPINNED_REVISION"
  | "HOST_REFUSED"
  | "TOO_MANY_REDIRECTS"
  | "RATE_LIMITED"
  | "RANGE_NOT_HONORED"
  | "BAD_RANGE"
  | "SIZE_MISMATCH"
  | "TRUNCATED_BODY"
  | "HTTP"
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK";

/** Toute panne de lecture distante : l'écran dit « non vérifié » (jamais « non estimé », qui est réservé à un en-tête illisible). */
export class GgufRangeError extends Error {
  constructor(
    readonly code: GgufRangeErrorCode,
    message: string,
    readonly extra: { status?: number; retryAfterSeconds?: number | null } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "GgufRangeError";
  }
  get status(): number | undefined {
    return this.extra.status;
  }
  /** Pour `RATE_LIMITED` : secondes à attendre d'après `Retry-After` (secondes ou date HTTP), `null` si absent ou illisible. */
  get retryAfterSeconds(): number | null | undefined {
    return this.extra.retryAfterSeconds;
  }
}

export const GGUF_RANGE_TIMEOUT_MS = 20_000;
export const GGUF_RANGE_MAX_REDIRECTS = HF_MAX_REDIRECTS;

export interface HttpRangeOptions {
  /** `https://huggingface.co/<owner>/<repo>/resolve/<sha de 40 hexadécimaux>/<fichier>` — jamais `resolve/main` (exigence a). */
  url: string;
  /** Hôte de l'API (seul destinataire du jeton). Défaut : `https://huggingface.co` ; le serveur factice des tests passe son origine. */
  baseUrl?: string;
  /** Origines de CDN supplémentaires admises (tests : un second serveur factice). */
  extraTrustedOrigins?: readonly string[];
  /** Taille publiée par l'API : recoupée avec le total du `Content-Range` (rejet si différents). */
  expectedSize?: number;
  /** Jeton existant du fournisseur ; envoyé à `baseUrl` seulement, retiré dès qu'un saut en sort. */
  token?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Délai de CHAQUE lecture (en-têtes et corps), 20 s par défaut. */
  timeoutMs?: number;
}

const SHA = /^[0-9a-f]{40}$/;

/** `https://huggingface.co/<owner>/<repo>/resolve/<rev>/…` : la révision doit être un commit épinglé. */
function assertPinned(url: URL): void {
  const seg = url.pathname.split("/").filter(Boolean);
  const i = seg.indexOf("resolve");
  if (i < 0 || !SHA.test(seg[i + 1] ?? "")) {
    throw new GgufRangeError("UNPINNED_REVISION", "l'adresse doit viser une révision épinglée (resolve/<sha du commit>/…), jamais resolve/main");
  }
}

export type HttpRangeSource = GgufByteSource & {
  /** Octets de CORPS lus au total (les en-têtes et le corps des redirections ne comptent pas) — pour le budget de l'action « Check all ». */
  transferred(): number;
  /** Requêtes HTTP envoyées au total, redirections comprises. */
  requests(): number;
};

export function httpRangeSource(o: HttpRangeOptions): HttpRangeSource {
  const base = new URL(o.baseUrl ?? HF_BASE_URL);
  const trusted = [base.origin, ...(o.extraTrustedOrigins ?? [])];
  const doFetch = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? GGUF_RANGE_TIMEOUT_MS;
  const start = new URL(o.url);
  if (!isHfUrlAllowed(start, trusted)) throw new GgufRangeError("HOST_REFUSED", `hôte non admis : ${start.host}`);
  assertPinned(start);
  let transferred = 0;
  let requests = 0;
  let knownTotal: number | null = null;

  const read = async (offset: number, length: number): Promise<{ bytes: Uint8Array; total: number }> => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) {
      throw new GgufRangeError("BAD_RANGE", `tranche demandée invalide (${offset}, ${length})`);
    }
    const last = offset + length - 1;
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    const onAbort = () => timer.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    if (o.signal?.aborted) timer.abort();
    const failure = (): GgufRangeError => new GgufRangeError(o.signal?.aborted ? "ABORTED" : "TIMEOUT", o.signal?.aborted ? "lecture annulée" : `aucune réponse en ${timeoutMs} ms`);
    try {
      let res: Response;
      try {
        // Le jeton ne part qu'à l'hôte de base ; le `Range` part à CHAQUE saut (le premier saut ne répond pas 206).
        res = await followHfRedirects({
          url: start,
          trusted,
          maxRedirects: GGUF_RANGE_MAX_REDIRECTS,
          fetchImpl: doFetch,
          signal: timer.signal,
          onRequest: () => {
            requests++;
          },
          // Recoupement du premier saut : `X-Linked-Size` contre la taille de l'API, avant le moindre octet de corps (chantier 5a).
          onRedirect: (r) => {
            const problem = o.expectedSize === undefined ? null : linkedSizeProblem(r, o.expectedSize);
            if (problem) throw new GgufRangeError("SIZE_MISMATCH", problem);
          },
          headersFor: (u) => {
            const headers: Record<string, string> = { Range: `bytes=${offset}-${last}`, "Accept-Encoding": "identity" };
            if (o.token && u.origin === base.origin) headers.Authorization = `Bearer ${o.token}`;
            return headers;
          },
          fail: (code, message, status) => new GgufRangeError(code, message, status === undefined ? {} : { status }),
        });
      } catch (e) {
        if (e instanceof GgufRangeError) throw e;
        if (timer.signal.aborted) throw failure();
        throw new GgufRangeError("NETWORK", `requête impossible (${(e as Error).message.slice(0, 120)})`);
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        throw new GgufRangeError("RATE_LIMITED", "Hugging Face limite le débit", { status: 429, retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")) });
      }
      if (res.status === 200) {
        // Le serveur ignore `Range` : il enverrait le fichier ENTIER. On coupe tout de suite, sans lire un octet de corps.
        await res.body?.cancel().catch(() => undefined);
        throw new GgufRangeError("RANGE_NOT_HONORED", "le serveur n'a pas honoré Range (réponse 200)", { status: 200 });
      }
      if (res.status !== 206) {
        await res.body?.cancel().catch(() => undefined);
        throw new GgufRangeError("HTTP", `réponse ${res.status}`, { status: res.status });
      }
      return await readPartial(res, offset, last);
    } finally {
      clearTimeout(timeout);
      o.signal?.removeEventListener("abort", onAbort);
    }

    async function readPartial(res: Response, from: number, to: number): Promise<{ bytes: Uint8Array; total: number }> {
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
      if (!m) {
        await res.body?.cancel().catch(() => undefined);
        throw new GgufRangeError("BAD_RANGE", "Content-Range absent ou illisible");
      }
      const [a, b, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      // Tolérance nulle : début exact, fin dans la tranche demandée, total cohérent avec l'API et avec les lectures précédentes.
      if (a !== from || b < a || b > to || total < b + 1) {
        await res.body?.cancel().catch(() => undefined);
        throw new GgufRangeError("BAD_RANGE", `Content-Range ${a}-${b}/${total} incohérent avec la tranche ${from}-${to}`);
      }
      if ((o.expectedSize !== undefined && total !== o.expectedSize) || (knownTotal !== null && total !== knownTotal)) {
        await res.body?.cancel().catch(() => undefined);
        throw new GgufRangeError("SIZE_MISMATCH", `taille totale ${total} différente de celle attendue (${knownTotal ?? o.expectedSize})`);
      }
      knownTotal = total;
      const want = b - a + 1;
      const out = new Uint8Array(want);
      let got = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new GgufRangeError("TRUNCATED_BODY", "réponse 206 sans corps");
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (timer.signal.aborted) throw failure();
            throw new GgufRangeError("NETWORK", `lecture interrompue (${(e as Error).message.slice(0, 120)})`);
          }
          if (chunk.done) break;
          if (got + chunk.value.length > want) {
            transferred += want - got;
            throw new GgufRangeError("BAD_RANGE", "le corps dépasse la tranche annoncée");
          }
          out.set(chunk.value, got);
          got += chunk.value.length;
          transferred += chunk.value.length;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (got !== want) throw new GgufRangeError("TRUNCATED_BODY", `corps de ${got} octets pour ${want} annoncés`);
      return { bytes: out, total };
    }
  };

  return { read, transferred: () => transferred, requests: () => requests };
}
