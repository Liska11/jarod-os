/*
 * File de messages côté fenêtre : la forme de ce que la passerelle envoie (`queue.update`), et la bulle d'une consigne donnée à l'agent pendant
 * qu'il travaille. Pur, sans React ni réseau : le store appelle ces fonctions.
 */
import { type ChatState } from './chat-model.ts'

export interface QueuedItem {
  id: string
  text: string
  at: number
}

/** La liste d'une notification `queue.update` ou d'une réponse de `prompt.queue.list` ; ce qui n'a pas la bonne forme est ignoré. */
export function parseQueueItems(raw: unknown): QueuedItem[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const items: QueuedItem[] = []

  for (const entry of raw) {
    const row = (entry ?? {}) as { id?: unknown; text?: unknown; at?: unknown }

    if (typeof row.id === 'string' && typeof row.text === 'string') {
      items.push({ id: row.id, text: row.text, at: typeof row.at === 'number' ? row.at : 0 })
    }
  }

  return items
}

/** Le texte d'un message de pilotage donné à un tour en cours : une bulle de plus, le tour continue et sa prochaine réponse ouvre une nouvelle bulle. */
export function appendSteer(state: ChatState, text: string): ChatState {
  return {
    ...state,
    streaming: true,
    openAssistantId: null,
    messages: [...state.messages, { id: `steer-${state.messages.length}-${Date.now()}`, role: 'user', text, ts: Date.now() }]
  }
}

/** Ce que le composer fait d'un message écrit pendant qu'un tour tourne : le mettre en file, ou l'envoyer tout de suite si l'agent est libre. */
export type SendMode = 'send' | 'queue'

export function sendModeFor(chat: Pick<ChatState, 'streaming'> | null): SendMode {
  return chat?.streaming ? 'queue' : 'send'
}
