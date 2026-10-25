import type { GatewayEvent, SessionCreateResult, SessionResumeResult } from '@jarod-os/client'
import { atom, computed, map } from 'nanostores'
import { appendSystem, appendUser, type ChatState, emptyChat, fromTranscript, reduceChatEvent } from '../lib/chat-model.ts'
import { appendSteer, parseQueueItems, type QueuedItem, sendModeFor } from '../lib/prompt-queue.ts'
import { $env, $prefs } from './backend.ts'
import { gatewayCall, gatewayRequest, onAnyGatewayEvent } from './gateway.ts'
import { notify } from './notifications.ts'
import { refreshSessions, rememberRuntimeId } from './sessions.ts'

export const SESSION_SOURCE = 'herald_os'
/** Sessions this shell lists: its own (including those saved before the rename) and other interactive clients. */
export const LISTED_SESSION_SOURCES: ReadonlySet<string> = new Set([SESSION_SOURCE, 'hermes_os', 'desktop', 'cli', 'tui'])

/** Live chat state per runtime session id. */
export const $chats = map<Record<string, ChatState>>({})
export const $activeChatId = atom<string | null>(null)
export const $activeChat = computed([$chats, $activeChatId], (chats, id) => (id ? (chats[id] ?? null) : null))

/** Messages written while the agent was working, per runtime session id: they leave one by one as each turn ends. */
export const $queues = map<Record<string, QueuedItem[]>>({})

const CHAT_EVENTS = new Set<GatewayEvent['type']>([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'thinking.delta',
  'reasoning.delta',
  'tool.start',
  'tool.complete',
  'status.update',
  'session.title',
  'session.info',
  'session.usage',
  'error'
])

function adopt(result: SessionCreateResult | SessionResumeResult, fallbackStored?: string): ChatState {
  const stored = result.stored_session_id ?? fallbackStored ?? result.session_id
  const state = emptyChat(result.session_id, stored, result.info)
  state.messages = fromTranscript(result.messages ?? [])
  state.title = result.info?.title ?? state.title
  const inflight = 'inflight' in result ? result.inflight : null

  if (inflight?.assistant) {
    state.messages.push({ id: `inflight-${result.session_id}`, role: 'assistant', text: inflight.assistant, reasoning: '', streaming: Boolean(inflight.streaming), ts: Date.now() })
    state.openAssistantId = inflight.streaming ? `inflight-${result.session_id}` : null
  }

  state.streaming = Boolean(result.info?.running || ('running' in result && result.running))
  rememberRuntimeId(stored, result.session_id)

  return state
}

export function bindChatEvents(): () => void {
  return onAnyGatewayEvent(event => {
    const sid = event.session_id
    const type = event.type as string
    const payload = (event as { payload?: unknown }).payload as { items?: unknown; text?: unknown } | undefined

    // The gateway's own notifications (not part of the Hermes contract): the queue changed, or a queued message just started its turn.
    if (sid && type === 'queue.update') {
      $queues.setKey(sid, parseQueueItems(payload?.items))

      return
    }

    if (sid && type === 'prompt.started') {
      const started = $chats.get()[sid]

      if (started && typeof payload?.text === 'string') {
        $chats.setKey(sid, appendUser(started, payload.text))
      }

      return
    }

    if (!sid || !CHAT_EVENTS.has(event.type)) {
      return
    }

    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    const next = reduceChatEvent(current, event)

    if (next !== current) {
      $chats.setKey(sid, next)
    }

    if (event.type === 'message.complete' && $activeChatId.get() !== sid) {
      notify({ title: next.title || 'Hermes', body: 'Finished a turn in another session', level: 'info', surface: 'chat' })
    }

    if (event.type === 'session.title') {
      void refreshSessions()
    }
  })
}

export async function createChat(options: { cwd?: string; title?: string } = {}): Promise<ChatState> {
  const cwd = options.cwd ?? $prefs.get().defaultCwd ?? $env.get()?.homeDir ?? null
  const result = await gatewayRequest('session.create', { source: SESSION_SOURCE, cwd, title: options.title ?? null })
  const state = adopt(result)
  $chats.setKey(state.sessionId, state)
  $activeChatId.set(state.sessionId)
  void refreshSessions()
  void refreshQueue(state.sessionId)

  return state
}

export async function openStoredSession(storedId: string): Promise<ChatState> {
  const existing = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId)

  if (existing) {
    $activeChatId.set(existing.sessionId)

    return existing
  }

  const result = await gatewayRequest('session.resume', { session_id: storedId, source: SESSION_SOURCE })
  const state = adopt(result, storedId)
  $chats.setKey(state.sessionId, state)
  $activeChatId.set(state.sessionId)
  void refreshQueue(state.sessionId)

  return state
}

export interface SendPromptOptions {
  sessionId?: string
  cwd?: string
  /**
   * Client surface the turn comes from. `voice-live` makes the backend prepend its spoken-reply
   * note (short, no markdown) and accept `voiceContext`; the default is the shell itself.
   */
  surface?: 'voice-live'
  /** Recent spoken exchange (newest last) so "yes" or "Thursday, not Friday" has its referent. */
  voiceContext?: string
  /** The user spoke over an in-flight reply; the backend notes the interruption for the model. */
  interrupted?: boolean
}

/** Send a prompt to the active chat, creating one when none exists. Resolves with the session id used. */
export async function sendPrompt(text: string, options: SendPromptOptions = {}): Promise<string | null> {
  const trimmed = text.trim()

  if (!trimmed) {
    return null
  }

  let sid = options.sessionId ?? $activeChatId.get()

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat({ cwd: options.cwd })).sessionId
  }

  const before = $chats.get()[sid]

  if (before) {
    $chats.setKey(sid, appendUser(before, trimmed))
  }

  try {
    await gatewayRequest('prompt.submit', {
      session_id: sid,
      text: trimmed,
      surface: options.surface ?? SESSION_SOURCE,
      ...(options.surface && options.voiceContext ? { voice_context: options.voiceContext } : {}),
      ...(options.interrupted ? { interrupted: true } : {})
    })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, { ...appendSystem(current, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
  }

  return sid
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function showError(sid: string, error: unknown): void {
  const current = $chats.get()[sid]

  if (current) {
    $chats.setKey(sid, appendSystem(current, errorText(error), 'error'))
  }
}

/**
 * Write while the agent works: the message waits in the queue and leaves when the turn ends. With the agent idle it is an ordinary send
 * (the gateway starts the turn at once and says so).
 */
export async function queuePrompt(text: string, sessionId?: string): Promise<void> {
  const trimmed = text.trim()
  const sid = sessionId ?? $activeChatId.get()
  const chat = sid ? $chats.get()[sid] : null

  if (!trimmed || !sid || !chat || sendModeFor(chat) === 'send') {
    await sendPrompt(trimmed, sid ? { sessionId: sid } : {})

    return
  }

  try {
    const result = await gatewayCall<{ status: string }>('prompt.queue', { session_id: sid, text: trimmed })

    // The turn ended between the click and the call: the gateway started the message instead of queueing it.
    if (result.status === 'streaming') {
      const current = $chats.get()[sid]

      if (current) {
        $chats.setKey(sid, appendUser(current, trimmed))
      }
    }
  } catch (error) {
    showError(sid, error)
  }
}

/** Steer the turn in progress: the agent reads the note before its next step, without being interrupted. */
export async function steerPrompt(text: string, sessionId?: string): Promise<void> {
  const trimmed = text.trim()
  const sid = sessionId ?? $activeChatId.get()
  const chat = sid ? $chats.get()[sid] : null

  if (!trimmed || !sid || !chat) {
    return
  }

  try {
    await gatewayCall('prompt.steer', { session_id: sid, text: trimmed })
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, appendSteer(current, trimmed))
    }
  } catch (error) {
    // The turn finished before the note could be read: it is then simply the next message.
    if (errorText(error).includes('no turn is running')) {
      await sendPrompt(trimmed, { sessionId: sid })

      return
    }

    showError(sid, error)
  }
}

export async function refreshQueue(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (!sid) {
    return
  }

  try {
    const result = await gatewayCall<{ items?: unknown }>('prompt.queue.list', { session_id: sid })
    $queues.setKey(sid, parseQueueItems(result.items))
  } catch {
    // An engine without the queue (another backend) simply has none.
  }
}

export async function removeQueued(id: string, sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (sid) {
    await gatewayCall('prompt.queue.remove', { session_id: sid, id }).catch(error => showError(sid, error))
  }
}

export async function clearQueue(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (sid) {
    await gatewayCall('prompt.queue.clear', { session_id: sid }).catch(error => showError(sid, error))
  }
}

/** After a stopped or failed turn the queue waits; this sends its next message. */
export async function resumeQueue(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (!sid) {
    return
  }

  try {
    const result = await gatewayCall<{ status: string }>('prompt.queue.resume', { session_id: sid })
    const chat = $chats.get()[sid]

    // The started message's own bubble comes with the gateway's `prompt.started`; here the turn is just marked as running.
    if (result.status === 'streaming' && chat && !chat.streaming) {
      $chats.setKey(sid, { ...chat, streaming: true })
    }
  } catch (error) {
    showError(sid, error)
  }
}

export async function runSlash(command: string, sessionId?: string): Promise<void> {
  let sid = sessionId ?? $activeChatId.get()

  if (!sid || !$chats.get()[sid]) {
    sid = (await createChat()).sessionId
  }

  const chat = $chats.get()[sid]

  if (chat) {
    $chats.setKey(sid, appendUser(chat, command))
  }

  try {
    const result = await gatewayRequest('slash.exec', { session_id: sid, command })
    const current = $chats.get()[sid]

    if (!current) {
      return
    }

    if (result.type === 'send' || result.type === 'skill') {
      // The command resolved to a message the agent should receive.
      $chats.setKey(sid, { ...current, streaming: true })
      await gatewayRequest('prompt.submit', { session_id: sid, text: result.message ?? command, surface: SESSION_SOURCE })

      return
    }

    const text = [result.display ?? result.output ?? '', result.notice ?? '', result.warning ?? ''].filter(Boolean).join('\n\n')
    $chats.setKey(sid, { ...appendSystem(current, text || `${command} done`), streaming: false })
  } catch (error) {
    const current = $chats.get()[sid]

    if (current) {
      $chats.setKey(sid, { ...appendSystem(current, error instanceof Error ? error.message : String(error), 'error'), streaming: false })
    }
  }
}

export async function interruptChat(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()

  if (!sid) {
    return
  }

  await gatewayRequest('session.interrupt', { session_id: sid })
}

/** The conversation being compacted now: its button shows it, and a second press waits. */
export const $compacting = atom<string | null>(null)

/** Summarise the old exchanges to free context (the core's `/compact`), and say what came of it in the conversation. */
export async function compactChat(sessionId?: string): Promise<void> {
  const sid = sessionId ?? $activeChatId.get()
  const chat = sid ? $chats.get()[sid] : null

  if (!sid || !chat || chat.streaming || $compacting.get()) {
    return
  }

  $compacting.set(sid)

  try {
    const result = await gatewayRequest('slash.exec', { session_id: sid, command: '/compact' })
    const current = $chats.get()[sid]
    const text = [result.display ?? result.output ?? '', result.notice ?? '', result.warning ?? ''].filter(Boolean).join('\n\n')

    if (current) {
      $chats.setKey(sid, appendSystem(current, text || 'Context compacted.'))
    }
  } catch (error) {
    notify({ title: 'Could not compact the context', body: error instanceof Error ? error.message : String(error), level: 'error', surface: 'hermes' })
  } finally {
    $compacting.set(null)
  }
}

export function forgetChat(sessionId: string): void {
  const next = { ...$chats.get() }
  delete next[sessionId]
  $chats.set(next)
  $queues.setKey(sessionId, [])

  if ($activeChatId.get() === sessionId) {
    $activeChatId.set(null)
  }
}

export function resetChats(): void {
  $chats.set({})
  $queues.set({})
  $activeChatId.set(null)
}
