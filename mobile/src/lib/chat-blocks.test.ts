import { describe, expect, it } from 'vitest'
import { applyEvent, type Conversation, groupLines, isToolLine, type Line } from './chat-model.ts'

const S = 's'
const line = (id: string, role: Line['role'], text: string): Line => ({ id, role, text })

describe('folding tool calls', () => {
  it('turns a run of tools into one block between the messages', () => {
    const blocks = groupLines([line('1', 'user', 'Range mon bureau'), line('t1', 'tool', 'list_dir'), line('t2', 'tool', 'move_file'), line('2', 'assistant', 'Fait.')])
    expect(blocks.map(b => b.kind)).toEqual(['line', 'tools', 'line'])
    expect(blocks[1]).toMatchObject({ kind: 'tools', calls: [{ text: 'list_dir' }, { text: 'move_file' }] })
  })

  it('keeps two separate runs apart', () => {
    const blocks = groupLines([line('t1', 'tool', 'a'), line('m', 'assistant', 'Un moment'), line('t2', 'tool', 'b')])
    expect(blocks.map(b => b.kind)).toEqual(['tools', 'line', 'tools'])
  })

  it('folds a refused tool with the tools, but not the run’s own error', () => {
    const refused = line('t3', 'error', 'delete_file : refusé ou en échec')
    const failed = line('error:4', 'error', 'Le modèle ne répond pas')
    expect(isToolLine(refused)).toBe(true)
    expect(isToolLine(failed)).toBe(false)
    const blocks = groupLines([line('t1', 'tool', 'read_file'), refused, failed])
    expect(blocks.map(b => b.kind)).toEqual(['tools', 'line'])
    expect(blocks[0]).toMatchObject({ calls: [{ text: 'read_file' }, { text: 'delete_file : refusé ou en échec' }] })
  })

  it('is empty for an empty conversation', () => {
    expect(groupLines([])).toEqual([])
  })
})

describe('tool arguments', () => {
  const start: Conversation = { sessionId: S, lines: [], running: false }

  it('keeps the arguments the PC sent with the call', () => {
    const c = applyEvent(start, { type: 'tool-start', sessionId: S, call: { id: 'c1', name: 'read_file', args: { path: 'a.txt' } } })
    expect(c.lines[0]).toMatchObject({ role: 'tool', text: 'read_file', args: { path: 'a.txt' } })
  })

  it('works as before when the call comes without any', () => {
    const c = applyEvent(start, { type: 'tool-start', sessionId: S, call: { id: 'c1', name: 'read_file' } })
    expect(c.lines[0]).toEqual({ id: 'tool:c1', role: 'tool', text: 'read_file' })
  })
})
