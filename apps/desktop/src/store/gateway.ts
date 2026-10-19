import {
  type ConnectionState,
  type GatewayEvent,
  type GatewayEventName,
  type GatewayReadyPayload,
  JsonRpcGatewayClient,
  reconnectBackoffDelayMs,
  type RpcMethods,
  type ServerRequestHandler
} from '@jarod-os/client'
import { atom } from 'nanostores'
import { gatewayProtocols } from '../lib/ws-auth.ts'
import { $backend } from './backend.ts'

export const $connection = atom<ConnectionState>('idle')
export const $gatewayReady = atom<GatewayReadyPayload | null>(null)
/** Bumped on every (re)connect so stores can refresh backend-owned lists. */
export const $connectionEpoch = atom(0)

/** Set with the backend URL, before any dial: the factory below reads it on every (re)connect. */
let wsToken: string | null = null

const client = new JsonRpcGatewayClient({
  requestIdPrefix: 'os',
  // Long ACK: prompt.submit answers only after the turn is accepted, and the backend may be
  // building an agent on first use.
  requestTimeoutMs: 180_000,
  // Le jeton part en sous-protocole plutôt que dans l'URL : une URL finit dans les journaux, l'historique
  // et les messages d'erreur. Un navigateur ne peut pas poser d'en-tête sur un WebSocket (voir lib/ws-auth.ts).
  socketFactory: url => new WebSocket(url, gatewayProtocols(wsToken))
})

let targetUrl: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let attempt = 0
let dialing = false

client.on('gateway.ready', event => {
  attempt = 0
  $gatewayReady.set(event.payload ?? null)
  $connectionEpoch.set($connectionEpoch.get() + 1)
})

client.onState(state => {
  $connection.set(state)

  if ((state === 'closed' || state === 'error') && targetUrl) {
    scheduleReconnect()
  }
})

function scheduleReconnect(): void {
  if (reconnectTimer || !targetUrl) {
    return
  }

  const delay = reconnectBackoffDelayMs(attempt++, { capMs: 8000 })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void dial()
  }, delay)
}

async function dial(): Promise<void> {
  if (!targetUrl || dialing) {
    return
  }

  dialing = true

  try {
    await client.connect(targetUrl)
  } catch {
    // onState('error') already scheduled the next attempt.
  } finally {
    dialing = false
  }
}

/** Follows the backend: dial when it is ready, tear down when it is not. */
export function bindGatewayToBackend(): () => void {
  return $backend.subscribe(state => {
    const next = state.phase === 'ready' && state.wsUrl ? state.wsUrl : null
    wsToken = next ? state.wsToken ?? null : null

    if (next === targetUrl) {
      return
    }

    targetUrl = next
    attempt = 0

    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    if (!next) {
      client.close()
      $gatewayReady.set(null)

      return
    }

    void dial()
  })
}

export function gatewayRequest<M extends keyof RpcMethods>(
  method: M,
  params: RpcMethods[M]['params'],
  timeoutMs?: number
): Promise<RpcMethods[M]['result']> {
  return client.request<RpcMethods[M]['result']>(method, params as Record<string, unknown>, timeoutMs)
}

/** An RPC the typed contract does not know (the Jarod engine's own methods), with its own timeout. */
export function gatewayCall<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  return client.request<T>(method, params, timeoutMs)
}

export function onGatewayEvent<K extends GatewayEventName>(type: K, handler: (event: GatewayEvent<K>) => void): () => void {
  return client.on(type, handler)
}

export function onAnyGatewayEvent(handler: (event: GatewayEvent) => void): () => void {
  return client.onAny(handler)
}

export function onServerRequest(handler: ServerRequestHandler): () => void {
  return client.onRequest(handler)
}

export function isGatewayOpen(): boolean {
  return client.connectionState === 'open'
}
