import type { EngineApprovalOption, EngineEvent, EngineId } from '../../shared/engines.ts'

/*
 * `session/update` (ACP) → événements du shell, dans le vocabulaire de la passerelle Hermes (`message.delta`, `tool.start`…).
 * Rien n'est inventé : un type de mise à jour inconnu ne produit rien (et le moteur garde sa forme d'origine dans ses journaux).
 * Chez DSH, `agent_message_chunk` porte un message VALIDÉ entier (pas un flux de jetons) : c'est un delta, pas une fin de tour ;
 * la fin de tour est la réponse de `session/prompt` (`stopReason`), traduite par `turnEnded`.
 */

function contentText(content: unknown): string {
  if (!content || typeof content !== 'object') {
    return ''
  }

  const block = content as { type?: unknown; text?: unknown }

  return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
}

/** Le texte lisible du contenu d'un appel d'outil (`tool_call_update.content`), tronqué : l'aperçu, pas la sortie complète. */
function toolContentText(content: unknown, max = 2000): string {
  if (!Array.isArray(content)) {
    return ''
  }

  const text = content
    .map(item => (item && typeof item === 'object' && (item as { type?: unknown }).type === 'content' ? contentText((item as { content?: unknown }).content) : ''))
    .filter(Boolean)
    .join('\n')

  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Les arguments texte d'un appel d'outil (`rawInput` : commande, description, justification…), bornés : ce qu'une carte d'accord doit montrer. */
export function toolInput(raw: unknown, maxFields = 6, maxChars = 500): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  const fields = Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)

  return Object.fromEntries(fields.slice(0, maxFields).map(([key, value]) => [key, value.length > maxChars ? `${value.slice(0, maxChars)}…` : value]))
}

export function translateSessionUpdate(engine: EngineId, params: Record<string, unknown>): EngineEvent | null {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  const update = (params.update && typeof params.update === 'object' ? params.update : {}) as Record<string, unknown>

  if (!sessionId) {
    return null
  }

  const event = (type: EngineEvent['type'], payload: Record<string, unknown>): EngineEvent => ({ engine, sessionId, type, payload })

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)

      return text ? event('message.delta', { text }) : null
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)

      return text ? event('thinking.delta', { text }) : null
    }
    case 'tool_call':
      return event('tool.start', {
        toolCallId: String(update.toolCallId ?? ''),
        title: typeof update.title === 'string' ? update.title : '',
        kind: typeof update.kind === 'string' ? update.kind : 'other',
        status: typeof update.status === 'string' ? update.status : 'pending',
        input: toolInput(update.rawInput)
      })
    case 'tool_call_update': {
      const status = typeof update.status === 'string' ? update.status : ''
      const done = status === 'completed' || status === 'failed'

      return event(done ? 'tool.complete' : 'tool.update', {
        toolCallId: String(update.toolCallId ?? ''),
        status,
        ...(typeof update.title === 'string' ? { title: update.title } : {}),
        ...(toolContentText(update.content) ? { text: toolContentText(update.content) } : {})
      })
    }
    case 'usage_update':
      return typeof update.used === 'number'
        ? event('usage', {
            used: update.used,
            size: typeof update.size === 'number' ? update.size : null
          })
        : null
    default:
      return null
  }
}

/** La fin d'un tour : la réponse de `session/prompt`. `cancelled` quand Jarod l'a annulé. */
export function turnEnded(engine: EngineId, sessionId: string, result: unknown): EngineEvent {
  const stopReason = result && typeof result === 'object' && typeof (result as { stopReason?: unknown }).stopReason === 'string' ? (result as { stopReason: string }).stopReason : 'end_turn'

  return {
    engine,
    sessionId,
    type: 'message.complete',
    payload: { stopReason }
  }
}

/** Les choix d'une demande d'accord (`session/request_permission`), filtrés sur la forme ACP. */
export function approvalOptions(params: Record<string, unknown>): EngineApprovalOption[] {
  const options = Array.isArray(params.options) ? params.options : []

  return options.flatMap(option => {
    if (!option || typeof option !== 'object') {
      return []
    }

    const { optionId, kind, name } = option as Record<string, unknown>

    return typeof optionId === 'string' && typeof kind === 'string' ? [{ optionId, kind, name: typeof name === 'string' ? name : kind }] : []
  })
}

/**
 * L'appel d'outil qu'une demande d'accord accompagne : son identifiant, et son titre quand la demande le porte. DSH n'y met que
 * l'identifiant ; le titre et les arguments sont dans le `tool_call` envoyé juste avant (que le moteur garde).
 */
export function approvalToolCall(params: Record<string, unknown>): {
  toolCallId: string
  title?: string
  input?: Record<string, string>
} {
  const call = (params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {}) as Record<string, unknown>
  const input = toolInput(call.rawInput)

  return {
    toolCallId: typeof call.toolCallId === 'string' ? call.toolCallId : '',
    ...(typeof call.title === 'string' && call.title ? { title: call.title } : {}),
    ...(Object.keys(input).length ? { input } : {})
  }
}

/**
 * La réponse ACP à rendre pour un choix : l'option du bon genre (`allow_once`, `reject_once`), sinon `cancelled`.
 * Jamais `allow_always` : un accord durable se donne dans les règles de Jarod, pas par une réponse automatique.
 */
export function permissionOutcome(
  options: EngineApprovalOption[],
  decision: 'allow' | 'deny' | 'cancel',
  optionId?: string
): {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
} {
  if (decision === 'cancel') {
    return { outcome: { outcome: 'cancelled' } }
  }

  const chosen = optionId ? options.find(option => option.optionId === optionId) : undefined
  const wanted = decision === 'allow' ? 'allow_once' : 'reject_once'
  const pick = chosen && chosen.kind.startsWith(decision === 'allow' ? 'allow' : 'reject') && chosen.kind !== 'allow_always' ? chosen : options.find(option => option.kind === wanted)

  return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } }
}
