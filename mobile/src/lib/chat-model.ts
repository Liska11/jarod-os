/** One line of the conversation as the phone shows it. */
export interface Line {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  /** Still being written by the model. */
  streaming?: boolean
  /** Photos and files sent with the message (names only: the files stay on the PC). */
  files?: FileRef[]
}

export interface FileRef {
  name: string
  mime: string
  size: number
}

export interface Conversation {
  sessionId: string
  lines: Line[]
  running: boolean
}

/** What `messages.list` returns. */
export interface StoredMessage {
  id: string
  role: string
  content: string
  toolName?: string
  isError?: boolean
  attachments?: FileRef[]
}

/** A user or assistant message as a line, or null when it has nothing to show. */
function textLine(m: StoredMessage & { role: 'user' | 'assistant' }): Line | null {
  const files = m.attachments?.length ? m.attachments : undefined
  if (!m.content.trim() && !files) return null
  return files ? { id: m.id, role: m.role, text: m.content, files } : { id: m.id, role: m.role, text: m.content }
}

export function fromHistory(sessionId: string, messages: StoredMessage[]): Conversation {
  const lines: Line[] = []
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      const line = textLine(m as StoredMessage & { role: 'user' | 'assistant' })
      if (line) lines.push(line)
    } else if (m.role === 'tool' && m.toolName) {
      lines.push({ id: m.id, role: m.isError ? 'error' : 'tool', text: m.isError ? `${m.toolName} : refusé ou en échec` : m.toolName })
    }
  }
  return { sessionId, lines, running: false }
}

type AgentEvent =
  | { type: 'message'; sessionId: string; streamId?: string; message: StoredMessage }
  | { type: 'stream-start' | 'stream-reset'; sessionId: string; streamId: string }
  | { type: 'delta'; sessionId: string; streamId: string; text?: string }
  | { type: 'tool-start'; sessionId: string; call: { id: string; name: string } }
  | { type: 'error'; sessionId: string; error: string }
  | { type: 'done'; sessionId: string }
  | { type: string; sessionId: string }

/**
 * Applies one agent event to the conversation on screen. Pure: the same events in the same order
 * always give the same lines, which is what the tests check.
 */
export function applyEvent(c: Conversation, raw: Record<string, unknown>): Conversation {
  const e = raw as AgentEvent
  if (e.sessionId !== c.sessionId) return c
  const stream = (id: string) => `stream:${id}`
  switch (e.type) {
    case 'stream-start': {
      const { streamId } = e as { streamId: string }
      if (c.lines.some(l => l.id === stream(streamId))) return c
      return { ...c, running: true, lines: [...c.lines, { id: stream(streamId), role: 'assistant', text: '', streaming: true }] }
    }
    case 'delta': {
      const { streamId, text } = e as { streamId: string; text?: string }
      if (!text) return c
      const lines = c.lines.some(l => l.id === stream(streamId))
        ? c.lines.map(l => (l.id === stream(streamId) ? { ...l, text: l.text + text } : l))
        : [...c.lines, { id: stream(streamId), role: 'assistant' as const, text, streaming: true }]
      return { ...c, running: true, lines }
    }
    case 'stream-reset': {
      const { streamId } = e as { streamId: string }
      return { ...c, lines: c.lines.map(l => (l.id === stream(streamId) ? { ...l, text: '' } : l)) }
    }
    case 'message': {
      const { message: m, streamId } = e as { message: StoredMessage; streamId?: string }
      // The finished message replaces what was streamed for it.
      let lines = streamId ? c.lines.filter(l => l.id !== stream(streamId)) : c.lines
      if (m.role === 'user' || m.role === 'assistant') {
        const line = textLine(m as StoredMessage & { role: 'user' | 'assistant' })
        if (!line) return { ...c, lines }
        lines = lines.some(l => l.id === m.id) ? lines.map(l => (l.id === m.id ? line : l)) : [...lines, line]
      } else if (m.role === 'tool' && m.toolName && m.isError) {
        lines = [...lines, { id: m.id, role: 'error', text: `${m.toolName} : refusé ou en échec` }]
      }
      return { ...c, running: c.running || m.role === 'user', lines }
    }
    case 'tool-start': {
      const { call } = e as { call: { id: string; name: string } }
      return { ...c, lines: [...c.lines, { id: `tool:${call.id}`, role: 'tool', text: call.name }] }
    }
    case 'error': {
      const { error } = e as { error: string }
      return { ...c, running: false, lines: [...c.lines.map(l => ({ ...l, streaming: false })), { id: `error:${c.lines.length}`, role: 'error', text: error }] }
    }
    case 'done':
      return { ...c, running: false, lines: c.lines.map(l => (l.streaming ? { ...l, streaming: false } : l)) }
    default:
      return c
  }
}

/** A tool call's arguments, shortened for a phone screen but never hidden. */
export function describeArgs(args: unknown, max = 600): string {
  let text: string
  try {
    text = typeof args === 'string' ? args : JSON.stringify(args, null, 2)
  } catch {
    text = String(args)
  }
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} caractères de plus)` : text
}
