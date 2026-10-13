import type { GatewayEvent } from '@herald-os/client'
import { describe, expect, it } from 'vitest'
import { type AssistantMessage, appendUser, type ChatState, emptyChat, fromTranscript, reduceChatEvent, type ToolMessage } from './chat-model.ts'

const event = (type: string, payload?: unknown): GatewayEvent => ({ type, session_id: 's1', payload }) as unknown as GatewayEvent
const run = (state: ChatState, ...events: GatewayEvent[]) => events.reduce(reduceChatEvent, state)
const assistants = (state: ChatState) => state.messages.filter((m): m is AssistantMessage => m.role === 'assistant')
const tools = (state: ChatState) => state.messages.filter((m): m is ToolMessage => m.role === 'tool')

describe('a streamed turn', () => {
  it('gathers deltas into one bubble and closes it on message.complete', () => {
    const state = run(appendUser(emptyChat('s1', 'stored-1'), 'hello'), event('message.start'), event('message.delta', { text: 'Hel' }), event('message.delta', { text: 'lo!' }), event('message.complete', { text: 'Hello!', status: 'complete' }))
    const [reply] = assistants(state)

    expect(assistants(state)).toHaveLength(1)
    expect(reply).toMatchObject({ text: 'Hello!', streaming: false, status: 'complete' })
    expect(state.streaming).toBe(false)
    expect(state.openAssistantId).toBeNull()
  })

  it('keeps reasoning apart from the answer', () => {
    const state = run(emptyChat('s1', 's1'), event('reasoning.delta', { text: 'think' }), event('message.delta', { text: 'answer' }), event('message.complete', {}))

    expect(assistants(state)[0]).toMatchObject({ text: 'answer', reasoning: 'think' })
  })

  it('takes the final text when the stream was partial', () => {
    const state = run(emptyChat('s1', 's1'), event('message.delta', { text: 'Hel' }), event('message.complete', { text: 'Hello there', partial: true }))

    expect(assistants(state)[0].text).toBe('Hello there')
  })

  it('adds a bubble for a complete message that was never streamed', () => {
    const state = run(emptyChat('s1', 's1'), event('message.complete', { text: 'Done.' }))

    expect(assistants(state)).toEqual([expect.objectContaining({ text: 'Done.', streaming: false })])
  })
})

describe('tools in a turn', () => {
  it('seals the text before a tool call and opens a new bubble after it', () => {
    const state = run(
      emptyChat('s1', 's1'),
      event('message.delta', { text: 'Let me look.' }),
      event('tool.start', { tool_id: 't1', name: 'read_file', args: { path: 'a.txt' } }),
      event('tool.complete', { tool_id: 't1', name: 'read_file', result_text: 'content', duration_s: 0.2 }),
      event('message.delta', { text: 'It says content.' }),
      event('message.complete', {})
    )

    expect(state.messages.map(m => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(assistants(state).map(m => m.text)).toEqual(['Let me look.', 'It says content.'])
    expect(tools(state)[0]).toMatchObject({ toolId: 't1', running: false, resultText: 'content', durationS: 0.2, args: { path: 'a.txt' } })
  })

  it('stops every running tool when the turn ends, even without its completion', () => {
    const state = run(emptyChat('s1', 's1'), event('tool.start', { tool_id: 't1', name: 'run_shell' }), event('message.complete', { status: 'interrupted' }))

    expect(tools(state)[0].running).toBe(false)
    expect(state.streaming).toBe(false)
  })

  it('updates a tool already shown instead of adding a second row', () => {
    const state = run(emptyChat('s1', 's1'), event('tool.start', { tool_id: 't1', name: 'search' }), event('tool.start', { tool_id: 't1', name: 'search', args: { q: 'x' } }))

    expect(tools(state)).toHaveLength(1)
    expect(tools(state)[0].args).toEqual({ q: 'x' })
  })
})

describe('errors and session events', () => {
  it('turns an error event into an error line and stops streaming', () => {
    const state = run(appendUser(emptyChat('s1', 's1'), 'hi'), event('message.delta', { text: 'par' }), event('error', { message: 'provider down' }))

    expect(state.messages.at(-1)).toMatchObject({ role: 'system', level: 'error', text: 'provider down' })
    expect(state.streaming).toBe(false)
    expect(state.openAssistantId).toBeNull()
  })

  it('reports a failed turn that produced no text', () => {
    const state = run(emptyChat('s1', 's1'), event('message.complete', { status: 'error', error: 'rate limited' }))

    expect(state.messages.at(-1)).toMatchObject({ role: 'system', level: 'error', text: 'rate limited' })
  })

  it('follows the title, live info and usage', () => {
    const usage = { input: 10, output: 5 }
    const state = run(emptyChat('s1', 's1'), event('session.title', { title: 'Trip' }), event('session.info', { model: 'local' }), event('session.usage', { usage }))

    expect(state.title).toBe('Trip')
    expect(state.info).toMatchObject({ title: 'Trip', model: 'local' })
    expect(state.usage).toEqual(usage)
  })

  it('shows the activity line from thinking.delta without its spinner face, and clears it on empty text', () => {
    const shown = run(emptyChat('s1', 's1'), event('thinking.delta', { text: '(◕‿◕) waiting on the provider' }))

    expect(shown.status).toEqual({ kind: 'thinking', text: 'waiting on the provider' })
    expect(run(shown, event('thinking.delta', { text: '' })).status).toBeUndefined()
  })

  it('leaves the state untouched for an event it does not know', () => {
    const state = emptyChat('s1', 's1')

    expect(reduceChatEvent(state, event('skin.changed', {}))).toBe(state)
  })
})

describe('fromTranscript', () => {
  it('rebuilds the conversation, skipping hidden rows and empty assistant turns', () => {
    const messages = fromTranscript([
      { role: 'user', text: 'hi', timestamp: 1_700_000_000 },
      { role: 'assistant', text: '' },
      { role: 'assistant', text: 'hello' },
      { role: 'tool', name: 'read_file', tool_call_id: 'c1', text: 'body' },
      { role: 'system', text: 'compacted', display_kind: 'hidden' }
    ] as never)

    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[0].ts).toBe(1_700_000_000_000)
    expect(messages[2]).toMatchObject({ toolId: 'c1', resultText: 'body', running: false })
  })
})
