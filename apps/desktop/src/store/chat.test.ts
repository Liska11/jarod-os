import type { GatewayEvent } from '@herald-os/client'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
const listeners = new Set<(event: GatewayEvent) => void>()
const notify = vi.fn()
const refreshSessions = vi.fn(async () => undefined)

vi.mock('./gateway.ts', () => ({
  gatewayRequest: (...args: unknown[]) => request(...args),
  onAnyGatewayEvent: (handler: (event: GatewayEvent) => void) => {
    listeners.add(handler)

    return () => listeners.delete(handler)
  }
}))
vi.mock('./backend.ts', () => ({ $env: atom({ homeDir: '/home/me' }), $prefs: atom({ defaultCwd: null }) }))
vi.mock('./notifications.ts', () => ({ notify: (...args: unknown[]) => notify(...args) }))
vi.mock('./sessions.ts', () => ({ refreshSessions: () => refreshSessions(), rememberRuntimeId: vi.fn() }))

const { $activeChatId, $chats, bindChatEvents, compactChat, createChat, forgetChat, openStoredSession, resetChats, runSlash, sendPrompt, SESSION_SOURCE } = await import('./chat.ts')

const emit = (type: string, sessionId: string, payload?: unknown) => {
  for (const listener of listeners) {
    listener({ type, session_id: sessionId, payload } as unknown as GatewayEvent)
  }
}

/** Answers the gateway's RPCs the way the core does for a fresh session. */
function backend(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  let sessions = 0
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (overrides[method]) {
      return overrides[method](params)
    }

    switch (method) {
      case 'session.create':
        sessions++

        return { session_id: `run-${sessions}`, stored_session_id: `stored-${sessions}`, info: { title: params.title ?? '' }, messages: [] }
      case 'prompt.submit':
        return { ok: true }
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
}

let unbind = () => {}

beforeEach(() => {
  request.mockReset()
  notify.mockReset()
  resetChats()
  unbind = bindChatEvents()
})

afterEach(() => unbind())

describe('sending a prompt', () => {
  it('creates a session from the default folder, shows the prompt at once and submits it from this shell', async () => {
    backend()
    const sid = await sendPrompt('  hello  ')

    expect(sid).toBe('run-1')
    expect(request).toHaveBeenCalledWith('session.create', { source: SESSION_SOURCE, cwd: '/home/me', title: null })
    expect(request).toHaveBeenCalledWith('prompt.submit', { session_id: 'run-1', text: 'hello', surface: SESSION_SOURCE })
    expect($activeChatId.get()).toBe('run-1')
    expect($chats.get()['run-1'].messages).toEqual([expect.objectContaining({ role: 'user', text: 'hello' })])
    expect($chats.get()['run-1'].streaming).toBe(true)
  })

  it('ignores an empty prompt', async () => {
    backend()

    expect(await sendPrompt('   ')).toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('reuses the active session for the next prompt', async () => {
    backend()
    await sendPrompt('one')
    await sendPrompt('two')

    expect(request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
    expect($chats.get()['run-1'].messages.map(m => (m.role === 'user' ? m.text : m.role))).toEqual(['one', 'two'])
  })

  it('passes the voice context and the interruption only for a voice turn', async () => {
    backend()
    await sendPrompt('yes', { surface: 'voice-live', voiceContext: 'Shall I book it?', interrupted: true })

    expect(request).toHaveBeenCalledWith('prompt.submit', { session_id: 'run-1', text: 'yes', surface: 'voice-live', voice_context: 'Shall I book it?', interrupted: true })
  })

  it('shows a refused submission as an error and stops waiting', async () => {
    backend({
      'prompt.submit': () => {
        throw new Error('the model is not loaded')
      }
    })
    await sendPrompt('hello')
    const chat = $chats.get()['run-1']

    expect(chat.messages.at(-1)).toMatchObject({ role: 'system', level: 'error', text: 'the model is not loaded' })
    expect(chat.streaming).toBe(false)
  })
})

describe('events from the gateway', () => {
  it('streams the reply into the session it belongs to', async () => {
    backend()
    await sendPrompt('hello')
    emit('message.delta', 'run-1', { text: 'Hi' })
    emit('message.delta', 'run-1', { text: ' there' })
    emit('message.complete', 'run-1', { text: 'Hi there' })
    const chat = $chats.get()['run-1']

    expect(chat.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Hi there', streaming: false })
    expect(chat.streaming).toBe(false)
  })

  it('ignores events for sessions this shell does not hold, and non-chat events', async () => {
    backend()
    await sendPrompt('hello')
    const before = $chats.get()
    emit('message.delta', 'someone-else', { text: 'x' })
    emit('skin.changed', 'run-1', {})

    expect($chats.get()).toBe(before)
  })

  it('tells the person when a session in the background finishes', async () => {
    backend()
    await sendPrompt('long job')
    await createChat()
    emit('message.complete', 'run-1', { text: 'done' })

    expect($activeChatId.get()).toBe('run-2')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: 'Finished a turn in another session' }))
  })

  it('does not notify for the conversation on screen', async () => {
    backend()
    await sendPrompt('hello')
    emit('message.complete', 'run-1', { text: 'done' })

    expect(notify).not.toHaveBeenCalled()
  })
})

describe('resuming a stored session', () => {
  it('rebuilds the transcript and the reply still being written', async () => {
    backend({
      'session.resume': () => ({
        session_id: 'run-9',
        stored_session_id: 'stored-9',
        info: { title: 'Trip', running: true },
        messages: [{ role: 'user', text: 'plan it' }],
        inflight: { assistant: 'Day 1:', streaming: true }
      })
    })
    const chat = await openStoredSession('stored-9')

    expect(chat.title).toBe('Trip')
    expect(chat.streaming).toBe(true)
    expect(chat.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(chat.openAssistantId).toBe('inflight-run-9')

    emit('message.delta', 'run-9', { text: ' Lisbon' })

    expect($chats.get()['run-9'].messages.at(-1)).toMatchObject({ text: 'Day 1: Lisbon' })
  })

  it('switches to a session already open instead of resuming it twice', async () => {
    backend()
    await sendPrompt('hello')
    await createChat()
    const chat = await openStoredSession('stored-1')

    expect(chat.sessionId).toBe('run-1')
    expect($activeChatId.get()).toBe('run-1')
    expect(request.mock.calls.some(([method]) => method === 'session.resume')).toBe(false)
  })
})

describe('slash commands and compaction', () => {
  it('shows what a command printed', async () => {
    backend({ 'slash.exec': () => ({ type: 'output', output: 'Model: local', notice: 'switched' }) })
    await runSlash('/model')

    expect($chats.get()['run-1'].messages.at(-1)).toMatchObject({ role: 'system', text: 'Model: local\n\nswitched' })
    expect($chats.get()['run-1'].streaming).toBe(false)
  })

  it('sends the message a command expands to', async () => {
    backend({ 'slash.exec': () => ({ type: 'skill', message: 'Use the travel skill' }) })
    await runSlash('/travel')

    expect(request).toHaveBeenCalledWith('prompt.submit', { session_id: 'run-1', text: 'Use the travel skill', surface: SESSION_SOURCE })
  })

  it('does not compact a conversation while it is answering', async () => {
    backend({ 'slash.exec': () => ({ type: 'output', output: 'compacted' }) })
    await sendPrompt('hello')
    await compactChat()

    expect(request.mock.calls.some(([, params]) => (params as { command?: string }).command === '/compact')).toBe(false)

    emit('message.complete', 'run-1', { text: 'hi' })
    await compactChat()

    expect($chats.get()['run-1'].messages.at(-1)).toMatchObject({ role: 'system', text: 'compacted' })
  })
})

describe('forgetting', () => {
  it('drops a session and clears it from the screen', async () => {
    backend()
    await sendPrompt('hello')
    forgetChat('run-1')

    expect($chats.get()['run-1']).toBeUndefined()
    expect($activeChatId.get()).toBeNull()
  })
})
