import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../lib/chat-model.ts'
import { activityItems, nearBottom } from './ActivityFeed.tsx'

const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'x', ts: 1 })
const answer = (id: string, reasoning: string): ChatMessage => ({ id, role: 'assistant', text: 'réponse', reasoning, streaming: false, ts: 2 })
const tool = (id: string): ChatMessage => ({ id, role: 'tool', toolId: id, name: 'system_open', running: false, ts: 3 })

describe('activityItems', () => {
  it('keeps the reasoning and the tool calls, in order, and nothing else', () => {
    const items = activityItems([user('u1'), answer('a1', 'je réfléchis'), tool('t1'), answer('a2', '   '), answer('a3', 'ensuite')])

    expect(items.map(i => `${i.kind}:${i.message.id}`)).toEqual(['reasoning:a1', 'tool:t1', 'reasoning:a3'])
  })

  it('an empty conversation has no activity', () => {
    expect(activityItems([])).toEqual([])
    expect(activityItems([user('u1'), answer('a1', '')])).toEqual([])
  })

  it('only the last items are kept when the conversation is long', () => {
    const many: ChatMessage[] = Array.from({ length: 200 }, (_, i) => tool(`t${i}`))
    const items = activityItems(many, 80)

    expect(items).toHaveLength(80)
    expect(items[0]!.message.id).toBe('t120')
    expect(items.at(-1)!.message.id).toBe('t199')
  })
})

describe('nearBottom', () => {
  it('follows only a person already at the bottom of the activity list', () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true) // exactly at the end
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).toBe(true) // 40 px of rounding
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(false) // 100 px above: reading
  })
})
