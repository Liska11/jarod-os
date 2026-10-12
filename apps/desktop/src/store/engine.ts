import { atom } from 'nanostores'
import { rest } from '../lib/rest.ts'
import { $connectionEpoch } from './gateway.ts'

/** Which engine answers: the Jarod core, or a Hermes runtime. Some settings only make sense for one of them (the engine says what it is in `/api/status`). */
export type EngineKind = 'jarod' | 'hermes' | null

export const $engineKind = atom<EngineKind>(null)

export function engineKindOf(status: { backend?: unknown } | null | undefined): EngineKind {
  return status ? (status.backend === 'jarod' ? 'jarod' : 'hermes') : null
}

/** Ask the engine what it is each time the connection comes (back). */
export function bindEngineKind(): () => void {
  return $connectionEpoch.subscribe(epoch => {
    if (epoch === 0) {
      return
    }

    rest.get<{ backend?: unknown }>('/api/status').then(status => $engineKind.set(engineKindOf(status)), () => $engineKind.set(null))
  })
}
