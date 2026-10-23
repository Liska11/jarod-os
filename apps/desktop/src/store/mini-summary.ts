import type { MiniSummary } from '../../shared/ipc.ts'
import type { ChatState } from '../lib/chat-model.ts'
import { type AgentActivity, $agents } from './agents.ts'
import { $chats } from './chat.ts'
import { $pendingRequests, type PendingRequest } from './requests.ts'

/*
 * Lot C (2026-10-21) : le résumé que la mini-fenêtre affiche, calculé ici à partir des stores existants (conversations, demandes en attente,
 * sous-agents) — sans rien leur ajouter. Il ne porte que des titres et des phrases coupées : jamais un message, une commande entière ou un
 * secret (le main le re-valide de toute façon).
 */

const cut = (s: unknown, n: number): string => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : '')

/** Ce qu'une demande en attente dit d'elle-même, en une phrase courte ; rien pour un secret ou un mot de passe administrateur. */
function waitingText(entry: PendingRequest): string {
  const p = entry.request.params as Record<string, unknown>

  if (entry.kind === 'approval') {
    return cut(p.description || p.tool_name || p.command, 100)
  }

  if (entry.kind === 'clarify') {
    return cut(p.question, 100)
  }

  return ''
}

export function computeMiniSummary(chats: Record<string, ChatState>, pending: readonly PendingRequest[], agents: Record<string, AgentActivity>): MiniSummary {
  const working = Object.values(chats).filter(chat => chat.streaming)

  return {
    working: working.slice(0, 3).map(chat => ({ title: cut(chat.title || 'Conversation', 80), status: cut(chat.status?.text ?? '', 80) })),
    workingCount: working.length,
    // Les plus anciennes d'abord : c'est la première qui bloque.
    waiting: pending.slice(0, 3).map(entry => ({ kind: entry.kind, text: waitingText(entry) })),
    waitingCount: pending.length,
    agents: Object.values(agents).filter(agent => agent.status === 'running').length
  }
}

/** Envoie le résumé au main à chaque changement (au plus tous les 250 ms, et seulement s'il a changé). */
export function bindMiniSummary(): () => void {
  const api = window.jarodOS?.mini

  if (!api) {
    return () => {}
  }

  let last = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    const summary = computeMiniSummary($chats.get(), $pendingRequests.get(), $agents.get())
    const text = JSON.stringify(summary)

    if (text !== last) {
      last = text
      api.state(summary)
    }
  }

  const schedule = () => {
    timer ??= setTimeout(flush, 250)
  }

  const offs = [$chats.listen(schedule), $pendingRequests.listen(schedule), $agents.listen(schedule)]

  schedule()

  return () => {
    clearTimeout(timer)
    for (const off of offs) {
      off()
    }
  }
}
