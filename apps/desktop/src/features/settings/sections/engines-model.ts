import type { PillTone } from '../../../components/ui/glass.tsx'
import type { CapabilityLevel, EngineApprovalOption, EngineEvent, EngineState } from '../../../../shared/engines.ts'

/** Réglages › Moteurs : ce qui se calcule sans écran (testé), séparé du composant. */

export const stateTone = (state: EngineState): PillTone => (state === 'connected' ? 'ok' : state === 'failed' ? 'danger' : state === 'starting' ? 'progress' : state === 'absent' ? 'muted' : 'info')

export const levelTone = (level: CapabilityLevel): PillTone => (level === 'available' ? 'ok' : level === 'partial' ? 'warn' : 'muted')

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; done: boolean; stopReason?: string }
  | {
      kind: 'tool'
      toolCallId: string
      title: string
      status: string
      text?: string
    }
  | {
      kind: 'approval'
      requestId: string
      title: string
      input: Record<string, string>
      options: EngineApprovalOption[]
      decision?: string
      automatic?: boolean
    }
  | { kind: 'error'; text: string }

/** Le fil d'une session conduite à côté : chaque événement du moteur y entre une fois, dans l'ordre. */
export function applyEngineEvent(entries: TranscriptEntry[], event: EngineEvent): TranscriptEntry[] {
  const next = [...entries]
  const last = next.at(-1)
  const text = typeof event.payload.text === 'string' ? event.payload.text : ''

  switch (event.type) {
    case 'message.delta':
      if (last?.kind === 'assistant' && !last.done) {
        next[next.length - 1] = { ...last, text: last.text + text }
      } else {
        next.push({ kind: 'assistant', text, done: false })
      }

      return next
    case 'message.complete': {
      const stopReason = typeof event.payload.stopReason === 'string' ? event.payload.stopReason : undefined
      const open = next.findLastIndex(entry => entry.kind === 'assistant' && !entry.done)

      if (open >= 0) {
        next[open] = {
          ...(next[open] as Extract<TranscriptEntry, { kind: 'assistant' }>),
          done: true,
          stopReason
        }
      } else {
        next.push({ kind: 'assistant', text: '', done: true, stopReason })
      }

      return next
    }
    case 'tool.start':
      next.push({
        kind: 'tool',
        toolCallId: String(event.payload.toolCallId ?? ''),
        title: String(event.payload.title ?? ''),
        status: String(event.payload.status ?? '')
      })

      return next
    case 'tool.update':
    case 'tool.complete': {
      const index = next.findLastIndex(entry => entry.kind === 'tool' && entry.toolCallId === event.payload.toolCallId)

      if (index >= 0) {
        const tool = next[index] as Extract<TranscriptEntry, { kind: 'tool' }>
        next[index] = {
          ...tool,
          status: String(event.payload.status ?? tool.status),
          ...(text ? { text } : {})
        }
      }

      return next
    }
    case 'approval.request':
      next.push({
        kind: 'approval',
        requestId: String(event.payload.requestId ?? ''),
        title: String(event.payload.title ?? ''),
        input: (event.payload.input ?? {}) as Record<string, string>,
        options: (event.payload.options ?? []) as EngineApprovalOption[]
      })

      return next
    case 'approval.resolved': {
      const index = event.payload.requestId ? next.findLastIndex(entry => entry.kind === 'approval' && entry.requestId === event.payload.requestId) : -1

      if (index >= 0) {
        next[index] = {
          ...(next[index] as Extract<TranscriptEntry, { kind: 'approval' }>),
          decision: String(event.payload.decision)
        }
      } else {
        // Réponse automatique (règle « refuser » ou « accepter ») : elle se voit dans le fil, elle n'est pas silencieuse.
        next.push({
          kind: 'approval',
          requestId: '',
          title: String(event.payload.title ?? ''),
          input: (event.payload.input ?? {}) as Record<string, string>,
          options: [],
          decision: String(event.payload.decision),
          automatic: true
        })
      }

      return next
    }
    case 'error':
      next.push({ kind: 'error', text: String(event.payload.message ?? '') })

      return next
    default:
      return entries
  }
}

/** Une demande d'accord encore ouverte (sans décision) : la carte à présenter. */
export const openApproval = (entries: TranscriptEntry[]) => entries.findLast((entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval' && !entry.decision && Boolean(entry.requestId))

/** Un tour est en cours tant que la dernière réponse n'est pas terminée et qu'aucune erreur ne l'a close. */
export function turnRunning(entries: TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]

    if (entry.kind === 'error') return false
    if (entry.kind === 'assistant') return !entry.done
    if (entry.kind === 'user') return true
  }

  return false
}
