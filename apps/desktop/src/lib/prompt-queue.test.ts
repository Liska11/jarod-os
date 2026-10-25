import { describe, expect, it } from 'vitest'
import { appendUser, emptyChat } from './chat-model.ts'
import { appendSteer, parseQueueItems, sendModeFor } from './prompt-queue.ts'

describe('parseQueueItems', () => {
  it('keeps well-formed items in order and drops anything else', () => {
    expect(parseQueueItems([{ id: 'a', text: 'one', at: 5 }, { id: 'b', text: 'two' }, { id: 3, text: 'bad id' }, null, 'x', { id: 'c' }])).toEqual([
      { id: 'a', text: 'one', at: 5 },
      { id: 'b', text: 'two', at: 0 }
    ])
  })

  it('treats a missing or wrong payload as an empty queue', () => {
    expect(parseQueueItems(undefined)).toEqual([])
    expect(parseQueueItems({ items: [] })).toEqual([])
  })
})

describe('appendSteer', () => {
  it('adds the note as a user bubble, keeps the turn streaming, and makes the next reply open a new bubble', () => {
    const before = { ...appendUser(emptyChat('s1', 'stored'), 'go'), openAssistantId: 'open-1' }
    const after = appendSteer(before, 'only in src')

    expect(after.streaming).toBe(true)
    expect(after.openAssistantId).toBeNull()
    expect(after.messages.at(-1)).toMatchObject({ role: 'user', text: 'only in src' })
    expect(after.messages).toHaveLength(before.messages.length + 1)
  })
})

describe('sendModeFor', () => {
  it('queues while the agent is working and sends otherwise', () => {
    expect(sendModeFor({ streaming: true })).toBe('queue')
    expect(sendModeFor({ streaming: false })).toBe('send')
    expect(sendModeFor(null)).toBe('send')
  })
})
