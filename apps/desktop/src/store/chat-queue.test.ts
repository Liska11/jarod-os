import type { GatewayEvent } from '@jarod-os/client'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
const call = vi.fn()
const listeners = new Set<(event: GatewayEvent) => void>()

vi.mock('./gateway.ts', () => ({
  gatewayRequest: (...args: unknown[]) => request(...args),
  gatewayCall: (...args: unknown[]) => call(...args),
  onAnyGatewayEvent: (handler: (event: GatewayEvent) => void) => {
    listeners.add(handler)

    return () => listeners.delete(handler)
  }
}))
vi.mock('./backend.ts', () => ({ $env: atom({ homeDir: '/home/me' }), $prefs: atom({ defaultCwd: null }) }))
vi.mock('./notifications.ts', () => ({ notify: vi.fn() }))
vi.mock('./sessions.ts', () => ({ refreshSessions: async () => undefined, rememberRuntimeId: vi.fn() }))

const { $chats, $queues, bindChatEvents, clearQueue, queuePrompt, removeQueued, resetChats, resumeQueue, steerPrompt } = await import('./chat.ts')
const { appendUser, emptyChat } = await import('../lib/chat-model.ts')

const emit = (type: string, sessionId: string, payload?: unknown) => {
  for (const listener of listeners) {
    listener({ type, session_id: sessionId, payload } as unknown as GatewayEvent)
  }
}

const userTexts = (sid: string) => ($chats.get()[sid]?.messages ?? []).filter(m => m.role === 'user').map(m => (m as { text: string }).text)

let unbind = () => {}

beforeEach(() => {
  request.mockReset()
  call.mockReset()
  resetChats()
  unbind = bindChatEvents()
  request.mockResolvedValue({ ok: true })
  call.mockResolvedValue({})
})

afterEach(() => unbind())

/** A chat the agent is working in (streaming) or has finished (idle). */
function chat(sid: string, streaming: boolean) {
  const base = emptyChat(sid, `stored-${sid}`)
  $chats.setKey(sid, streaming ? appendUser(base, 'first question') : base)
}

describe('queue notifications', () => {
  it('queue.update replaces the list for that session, ignoring malformed rows', () => {
    chat('s1', true)
    emit('queue.update', 's1', { items: [{ id: 'a', text: 'one', at: 1 }, { nope: true }] })

    expect($queues.get().s1).toEqual([{ id: 'a', text: 'one', at: 1 }])

    emit('queue.update', 's1', { items: [] })
    expect($queues.get().s1).toEqual([])
  })

  it('prompt.started shows the queued message as the user bubble of the turn that just began', () => {
    chat('s1', false)
    emit('prompt.started', 's1', { text: 'the second question', from_queue: true })

    expect(userTexts('s1')).toEqual(['the second question'])
    expect($chats.get().s1?.streaming).toBe(true)
  })

  it('ignores both for a conversation this window does not hold', () => {
    emit('queue.update', 'ghost', { items: [{ id: 'a', text: 'x', at: 0 }] })
    emit('prompt.started', 'ghost', { text: 'x' })

    expect($chats.get().ghost).toBeUndefined()
  })
})

describe('queuePrompt', () => {
  it('while the agent works, queues the message instead of failing with "already running"', async () => {
    chat('s1', true)
    call.mockResolvedValueOnce({ status: 'queued', id: 'q1', position: 1 })

    await queuePrompt('and then this', 's1')

    expect(call).toHaveBeenCalledWith('prompt.queue', { session_id: 's1', text: 'and then this' })
    expect(request).not.toHaveBeenCalled()
    expect(userTexts('s1')).toEqual(['first question']) // the bubble appears when it starts, not when it is queued
  })

  it('if the turn ended in between, the gateway starts it and the bubble appears at once', async () => {
    chat('s1', true)
    call.mockResolvedValueOnce({ status: 'streaming' })

    await queuePrompt('late message', 's1')

    expect(userTexts('s1')).toEqual(['first question', 'late message'])
  })

  it('with the agent idle, it is an ordinary send', async () => {
    chat('s1', false)

    await queuePrompt('hello', 's1')

    expect(request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ session_id: 's1', text: 'hello' }))
    expect(call).not.toHaveBeenCalledWith('prompt.queue', expect.anything())
  })

  it('a refusal (full queue) is shown in the conversation', async () => {
    chat('s1', true)
    call.mockRejectedValueOnce(new Error('la file est pleine (20 messages)'))

    await queuePrompt('one too many', 's1')

    const last = $chats.get().s1!.messages.at(-1)!
    expect(last).toMatchObject({ role: 'system', level: 'error' })
    expect((last as { text: string }).text).toContain('pleine')
  })
})

describe('steerPrompt', () => {
  it('adds the note as a bubble without ending the turn', async () => {
    chat('s1', true)

    await steerPrompt('only in src', 's1')

    expect(call).toHaveBeenCalledWith('prompt.steer', { session_id: 's1', text: 'only in src' })
    expect(userTexts('s1')).toEqual(['first question', 'only in src'])
    expect($chats.get().s1?.streaming).toBe(true)
  })

  it('if the turn already finished, the note is simply sent as the next message', async () => {
    chat('s1', true)
    call.mockRejectedValueOnce(new Error('no turn is running in this session'))

    await steerPrompt('too late', 's1')

    expect(request).toHaveBeenCalledWith('prompt.submit', expect.objectContaining({ session_id: 's1', text: 'too late' }))
  })
})

describe('queue controls', () => {
  it('remove, clear and resume are gateway calls on the right conversation', async () => {
    chat('s1', false)
    call.mockResolvedValue({ status: 'streaming' })

    await removeQueued('q1', 's1')
    await clearQueue('s1')
    await resumeQueue('s1')

    expect(call).toHaveBeenNthCalledWith(1, 'prompt.queue.remove', { session_id: 's1', id: 'q1' })
    expect(call).toHaveBeenNthCalledWith(2, 'prompt.queue.clear', { session_id: 's1' })
    expect(call).toHaveBeenNthCalledWith(3, 'prompt.queue.resume', { session_id: 's1' })
    expect($chats.get().s1?.streaming).toBe(true) // resumed: a turn is running again
  })
})
