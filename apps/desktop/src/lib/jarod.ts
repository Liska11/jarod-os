import { gatewayCall, onAnyGatewayEvent, onServerRequest } from '../store/gateway.ts'

/*
 * The Jarod engine's control channels (the cordis desktop app's `window.oneai` surface: providers, local models, skills, profiles, messaging, backups…)
 * as one call. `jarod('local-models-list')` runs the handler of the same name in the engine and returns what it returns; a refusal rejects with the
 * handler's own message. Handlers push progress as events (`onJarodEvent('local-engine-progress', …)`); native gestures they need (a file picker, a
 * confirmation) come back to this window as `jarod.shell` requests and are shown by the main process.
 */

/** Installing an engine or downloading a model can take long; the call waits (the engine reports progress through events meanwhile). */
const CALL_TIMEOUT_MS = 60 * 60 * 1000

export async function jarod<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const response = await gatewayCall<{ result: T }>('jarod.invoke', { channel, args }, CALL_TIMEOUT_MS)

  return response.result
}

type Listener = (...args: unknown[]) => void

const listeners = new Map<string, Set<Listener>>()

/** Subscribe to a channel the engine pushes (`local-engine-progress`, `local-models-activity`, `hf-download-progress`…). Returns the unsubscribe. */
export function onJarodEvent(channel: string, listener: Listener): () => void {
  const set = listeners.get(channel) ?? new Set<Listener>()

  set.add(listener)
  listeners.set(channel, set)

  return () => {
    set.delete(listener)
  }
}

export function dispatchJarodEvent(channel: string, args: unknown[]): void {
  for (const listener of [...(listeners.get(channel) ?? [])]) {
    try {
      listener(...args)
    } catch (error) {
      console.error(`jarod event ${channel}`, error)
    }
  }
}

/** Parse the payload of a `jarod.event`; anything else is ignored. */
export function jarodEventOf(payload: unknown): { channel: string; args: unknown[] } | null {
  const p = (payload ?? {}) as { channel?: unknown; args?: unknown }

  return typeof p.channel === 'string' && Array.isArray(p.args) ? { channel: p.channel, args: p.args } : null
}

/** Answer to a `jarod.shell` request: the user's choice, or null when the gesture failed or was dismissed (the engine reads null as a refusal). */
export async function answerShellRequest(kind: unknown, params: unknown, perform: (kind: string, params: Record<string, unknown>) => Promise<unknown>): Promise<{ value: unknown }> {
  if (typeof kind !== 'string') {
    return { value: null }
  }

  try {
    return { value: (await perform(kind, params && typeof params === 'object' ? (params as Record<string, unknown>) : {})) ?? null }
  } catch {
    return { value: null }
  }
}

export function bindJarod(): () => void {
  const offEvents = onAnyGatewayEvent(event => {
    if ((event.type as string) !== 'jarod.event') {
      return
    }

    const parsed = jarodEventOf(event.payload)

    if (parsed) {
      dispatchJarodEvent(parsed.channel, parsed.args)
    }
  })

  const offRequests = onServerRequest(request => {
    if (request.method !== 'jarod.shell') {
      return false
    }

    const { kind, ...params } = request.params as Record<string, unknown>

    void answerShellRequest(kind, params, window.heraldOS.jarod.shell).then(answer => request.respond(answer))

    return true
  })

  return () => {
    offEvents()
    offRequests()
  }
}
