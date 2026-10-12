/**
 * Transport Hugging Face PARTAGÉ (SPECS-P5-MODELS.md § 5 « Hôtes » et « Jeton », § 3.6 « 429 », § 3.9 (f) et (i)) : la lecture `Range` de l'en-tête (`gguf-range.ts`), le
 * téléchargement (`hf-transfer.ts`) et la lecture des métadonnées (`huggingface.ts`) passent par la MÊME boucle de redirections, pour qu'aucun chemin ne diverge.
 *
 *  - redirections MANUELLES : 3 au plus, l'hôte de CHAQUE saut est vérifié avant la requête suivante (jamais une requête vers un hôte refusé) ;
 *  - chaque saut passe par `fetchImpl` : un garde-fou de test voit chaque saut ;
 *  - les en-têtes sont recalculés à chaque saut (`headersFor`) : le jeton ne part qu'à l'origine de base, le `Range` est rejoué ;
 *  - cette fonction rend la première réponse qui n'est pas une redirection, quel que soit son statut : 429, 200, 206… sont à la charge de l'appelant.
 */
import { isIP } from "node:net";

export const HF_BASE_URL = "https://huggingface.co";
export const HF_MAX_REDIRECTS = 3;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** `Retry-After` : un nombre de secondes ou une date HTTP ; `null` quand absent ou illisible. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Un hôte admis : `https` vers `huggingface.co`, `hf.co` et leurs sous-domaines (CDN), jamais une adresse IP littérale ; en plus, l'origine de base
 * INJECTÉE par le code (le serveur factice des tests) et les origines supplémentaires injectées de même. Rien de ce qui vient d'un réglage, d'un canal
 * IPC ou d'un en-tête de réponse n'ajoute un hôte.
 */
export function isHfUrlAllowed(url: URL, trustedOrigins: readonly string[] = [HF_BASE_URL]): boolean {
  if (trustedOrigins.includes(url.origin)) return true;
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return false;
  return host === "huggingface.co" || host === "hf.co" || host.endsWith(".huggingface.co") || host.endsWith(".hf.co");
}

/**
 * Recoupe l'en-tête `X-Linked-Size` d'une réponse de redirection avec la taille publiée par l'API (SPECS-P5-MODELS.md § 3.10 (a)). `null` = rien à reprocher :
 * en-tête absent (rien à comparer) ou égal. Une valeur illisible (pas un entier décimal sûr, sans signe ni zéro de tête) est une divergence : jamais devinée.
 * `X-Linked-ETag` n'est PAS lu : c'est une empreinte Xet, pas un SHA-256 (décision du 2026-10-03).
 */
export function linkedSizeProblem(res: Response, expected: number): string | null {
  const raw = res.headers.get("x-linked-size");
  if (raw === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) return `X-Linked-Size illisible (${JSON.stringify(raw.slice(0, 40))})`;
  const announced = Number(raw);
  return announced === expected ? null : `X-Linked-Size annonce ${announced} octets, l'API ${expected}`;
}

export type RedirectFailure = "HOST_REFUSED" | "TOO_MANY_REDIRECTS" | "HTTP";

export interface FollowOptions {
  url: URL;
  /** Origines de confiance injectées par le code (l'origine de base, et en test un second serveur factice). */
  trusted: readonly string[];
  maxRedirects?: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  /** En-têtes de CHAQUE requête, calculés pour l'URL du saut (jeton à l'origine de base seulement, `Range` rejoué). */
  headersFor: (url: URL) => Record<string, string>;
  /** Appelé avant chaque requête, redirections comprises (compteurs). */
  onRequest?: () => void;
  /**
   * Appelé pour CHAQUE réponse de redirection (corps déjà abandonné, en-têtes lisibles) AVANT de suivre sa `Location` ; une exception l'interrompt : aucun saut
   * suivant n'est demandé. Sert au recoupement de `X-Linked-Size` (chantier 5a).
   */
  onRedirect?: (res: Response, from: URL) => void;
  /** Fabrique l'erreur de l'appelant (chaque appelant a sa classe d'erreur et ses codes). */
  fail: (code: RedirectFailure, message: string, status?: number) => Error;
}

/** Suit les redirections à la main et rend la première réponse qui n'en est pas une. Les échecs de `fetch` lui-même (réseau, annulation) sont relancés tels quels. */
export async function followHfRedirects(o: FollowOptions): Promise<Response> {
  const max = o.maxRedirects ?? HF_MAX_REDIRECTS;
  if (!isHfUrlAllowed(o.url, o.trusted)) throw o.fail("HOST_REFUSED", `hôte non admis : ${o.url.host}`);
  let url = o.url;
  for (let hop = 0; ; hop++) {
    o.onRequest?.();
    const res = await o.fetchImpl(url, { headers: o.headersFor(url), redirect: "manual", signal: o.signal });
    if (!REDIRECTS.has(res.status)) return res;
    await res.body?.cancel().catch(() => undefined);
    o.onRedirect?.(res, url);
    const location = res.headers.get("location");
    if (!location) throw o.fail("HTTP", `redirection ${res.status} sans Location`, res.status);
    if (hop >= max) throw o.fail("TOO_MANY_REDIRECTS", `plus de ${max} redirections`);
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw o.fail("HOST_REFUSED", "redirection vers une adresse illisible");
    }
    if (!isHfUrlAllowed(next, o.trusted)) throw o.fail("HOST_REFUSED", `redirection vers un hôte non admis : ${next.host}`);
    url = next;
  }
}

export type HfApiErrorCode = "HTTP" | "RATE_LIMITED" | "HOST_REFUSED" | "TOO_MANY_REDIRECTS" | "TOO_LARGE" | "BAD_RESPONSE" | "TOO_MANY_PAGES" | "NETWORK";

/** Échec d'une lecture de MÉTADONNÉES (recherche, fiche, liste). `HTTP` garde le préfixe historique `HUGGINGFACE_FAILED`. */
export class HfApiError extends Error {
  constructor(
    readonly code: HfApiErrorCode,
    message: string,
    readonly extra: { status?: number; retryAfterSeconds?: number | null } = {},
  ) {
    super(code === "HTTP" ? `HUGGINGFACE_FAILED: ${message}` : `${code}: ${message}`);
    this.name = "HfApiError";
  }
  get status(): number | undefined {
    return this.extra.status;
  }
  /** Pour `RATE_LIMITED` : secondes à attendre d'après `Retry-After`, `null` si absent ou illisible. */
  get retryAfterSeconds(): number | null | undefined {
    return this.extra.retryAfterSeconds;
  }
}
