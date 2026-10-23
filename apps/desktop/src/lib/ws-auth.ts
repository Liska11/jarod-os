/**
 * Le jeton de la passerelle ne voyage pas dans l'URL du WebSocket.
 *
 * Un navigateur ne peut pas poser d'en-tête sur un `WebSocket`, et il refuse toute autre forme : le
 * sous-protocole (`Sec-WebSocket-Protocol`) est donc la seule place où le jeton peut passer ailleurs que
 * dans l'URL — or une URL finit dans les journaux, l'historique et les messages d'erreur. On offre
 * `jarod-gw` en premier, pour que le serveur choisisse ce nom et ne renvoie jamais le jeton.
 *
 * Le client JSON-RPC amont (code Hermes vendu inchangé) construit lui-même son socket via
 * `GatewayClientOptions.socketFactory` : c'est le point d'insertion, sans toucher à l'amont.
 *
 * Doit rester aligné sur `jarod-core/packages/cli/src/gateway/ws.ts` (`WS_PROTOCOL` / `WS_TOKEN_PREFIX`).
 *
 * Exception : un backend Hermes (`wsAuth: 'query'`) ne connaît pas ce sous-protocole et n'accepte en local que
 * `?token=` (vérifié sur v0.22.4) ; sans cette forme, le shell ne pouvait plus s'y connecter.
 */
import type { GatewayAuth } from '../../shared/ipc.ts'

export const GATEWAY_PROTOCOL = 'jarod-gw'
export const GATEWAY_TOKEN_PREFIX = 'jarod.token.'

/** Un `Sec-WebSocket-Protocol` est un jeton RFC 7230 ; le base64url de la passerelle y passe tel quel. */
const SAFE_TOKEN = /^[A-Za-z0-9._~-]+$/

/** Les sous-protocoles à offrir : le nom, puis le jeton. Sans jeton, le nom seul. */
export function gatewayProtocols(token: string | null | undefined): string[] {
  if (!token) {
    return [GATEWAY_PROTOCOL]
  }

  if (!SAFE_TOKEN.test(token)) {
    // Mieux vaut échouer bruyamment que retomber en silence sur le jeton dans l'URL.
    throw new Error('jeton de passerelle inutilisable en sous-protocole WebSocket (caractères hors RFC 7230)')
  }

  return [GATEWAY_PROTOCOL, `${GATEWAY_TOKEN_PREFIX}${token}`]
}

/** L'URL et les sous-protocoles d'un socket de la passerelle, selon la forme que le backend accepte. */
export function gatewaySocketTarget(url: string, token: string | null | undefined, auth: GatewayAuth = 'subprotocol'): { url: string; protocols?: string[] } {
  if (auth === 'subprotocol') {
    return { url, protocols: gatewayProtocols(token) }
  }

  if (!token) {
    return { url }
  }

  const withToken = new URL(url)
  withToken.searchParams.set('token', token)

  return { url: withToken.toString() }
}

/** Ouvre ce socket : `new WebSocket` sans sous-protocole quand il n'y en a pas (un `[]` serait refusé par certains serveurs). */
export function openGatewaySocket(url: string, token: string | null | undefined, auth?: GatewayAuth): WebSocket {
  const target = gatewaySocketTarget(url, token, auth)

  return target.protocols ? new WebSocket(target.url, target.protocols) : new WebSocket(target.url)
}
