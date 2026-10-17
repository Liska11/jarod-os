/**
 * B4 (oauth4webapi) — OAuth 2.1 pour les serveurs MCP : code d'autorisation + PKCE (S256) + `state`.
 *
 * Les jetons vont dans le coffre et nulle part ailleurs : `completeAuthorization` n'en rend que le NOM d'entrée. Le
 * point de terminaison de jeton doit être en https (sauf boucle locale pour un serveur de test), la redirection doit
 * être une adresse de boucle locale, `state` est comparé en temps constant, et un code ne sert qu'une fois.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AdapterRefused } from "./common.js";

const b64url = (b: Buffer): string => b.toString("base64url");

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function createPkce(): PkcePair {
  const verifier = b64url(randomBytes(48)); // 64 caractères, dans [43, 128]
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()), method: "S256" };
}

export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}

function requireSecure(adapter: string, raw: string, what: string, allowLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AdapterRefused(adapter, `${what} : URL invalide`);
  }
  if (url.protocol !== "https:" && !(allowLoopback && isLoopback(url))) throw new AdapterRefused(adapter, `${what} doit être en https`);
  if (url.username || url.password) throw new AdapterRefused(adapter, `${what} ne doit pas contenir d'identifiants`);
  return url;
}

export interface AuthRequest {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
}

export interface PendingAuth {
  url: string;
  state: string;
  verifier: string;
  request: AuthRequest;
  used: boolean;
}

export function beginAuthorization(req: AuthRequest, opts: { allowLoopbackEndpoints?: boolean } = {}): PendingAuth {
  const auth = requireSecure("B4", req.authorizationEndpoint, "point d'autorisation", opts.allowLoopbackEndpoints === true);
  requireSecure("B4", req.tokenEndpoint, "point de jeton", opts.allowLoopbackEndpoints === true);
  const redirect = new URL(req.redirectUri);
  if (!isLoopback(redirect)) throw new AdapterRefused("B4", "la redirection doit être une adresse de boucle locale");
  if (!req.clientId.trim()) throw new AdapterRefused("B4", "client_id manquant");
  const pkce = createPkce();
  const state = b64url(randomBytes(24));
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("client_id", req.clientId);
  auth.searchParams.set("redirect_uri", req.redirectUri);
  auth.searchParams.set("scope", req.scopes.join(" "));
  auth.searchParams.set("state", state);
  auth.searchParams.set("code_challenge", pkce.challenge);
  auth.searchParams.set("code_challenge_method", pkce.method);
  return { url: auth.toString(), state, verifier: pkce.verifier, request: req, used: false };
}

export interface TokenVault {
  put(name: string, value: string): void;
}

export interface OAuthDeps {
  fetch: typeof fetch;
  vault: TokenVault;
}

/** Échange le code contre des jetons, les dépose dans le coffre, rend les NOMS des entrées. */
export async function completeAuthorization(pending: PendingAuth, callbackUrl: string, vaultPrefix: string, deps: OAuthDeps): Promise<{ accessName: string; refreshName: string | null; expiresIn: number | null }> {
  if (pending.used) throw new AdapterRefused("B4", "autorisation déjà utilisée");
  pending.used = true;
  const cb = new URL(callbackUrl);
  const expected = Buffer.from(pending.state);
  const got = Buffer.from(cb.searchParams.get("state") ?? "");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new AdapterRefused("B4", "state invalide");
  if (cb.searchParams.get("error")) throw new AdapterRefused("B4", `autorisation refusée : ${cb.searchParams.get("error")}`);
  const code = cb.searchParams.get("code");
  if (!code) throw new AdapterRefused("B4", "code manquant");
  const res = await deps.fetch(pending.request.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: pending.request.redirectUri, client_id: pending.request.clientId, code_verifier: pending.verifier }).toString(),
  });
  if (!res.ok) throw new AdapterRefused("B4", `échange refusé (HTTP ${res.status})`);
  const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; token_type?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) throw new AdapterRefused("B4", "réponse sans access_token");
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") throw new AdapterRefused("B4", "type de jeton non pris en charge");
  const accessName = `${vaultPrefix}_access_token`;
  deps.vault.put(accessName, body.access_token);
  let refreshName: string | null = null;
  if (typeof body.refresh_token === "string" && body.refresh_token) {
    refreshName = `${vaultPrefix}_refresh_token`;
    deps.vault.put(refreshName, body.refresh_token);
  }
  return { accessName, refreshName, expiresIn: typeof body.expires_in === "number" ? body.expires_in : null };
}
