import { describe, expect, it } from 'vitest'
import { chatToMarkdown, exportFileName, hastText } from './chat-export.ts'
import type { ChatMessage } from './chat-model.ts'

const labels = { you: 'Vous', assistant: 'Jarod', tool: 'Outil', exportedOn: 'Exportée le 31/10/2026', untitled: 'Sans titre' }
const at = (h: number, m: number, day = 31) => new Date(2026, 9, day, h, m).getTime()

const messages: ChatMessage[] = [
  { id: '1', role: 'user', text: 'Ouvre mon navigateur', ts: at(9, 5) },
  { id: '2', role: 'tool', toolId: 't1', name: 'open_app', running: false, ts: at(9, 5) } as ChatMessage,
  { id: '3', role: 'assistant', text: '  C’est fait.\n\n```sh\nls\n```  ', reasoning: 'pensée', streaming: false, ts: at(9, 6) },
  { id: '4', role: 'system', level: 'error', text: 'HTTP 500\nboom', ts: at(9, 7) } as ChatMessage,
  { id: '5', role: 'user', text: 'Merci', ts: at(8, 0, 30) }
]

describe('chatToMarkdown', () => {
  const md = chatToMarkdown('Mon titre', messages, labels)

  it('starts with the title and the export line', () => {
    expect(md.startsWith('# Mon titre\n\n_Exportée le 31/10/2026_\n')).toBe(true)
  })

  it('writes a heading per message with the time, and the text as written (trimmed)', () => {
    expect(md).toContain('## Vous · 09:05\n\nOuvre mon navigateur')
    expect(md).toContain('## Jarod · 09:06\n\nC’est fait.\n\n```sh\nls\n```\n')
  })

  it('keeps the reasoning out, mentions tools in one line and quotes system lines', () => {
    expect(md).not.toContain('pensée')
    expect(md).toContain('_Outil : open_app_')
    expect(md).toContain('> HTTP 500\n> boom')
  })

  it('marks each new day once', () => {
    expect(md.match(/\*\*2026-10-31\*\*/g)).toHaveLength(1)
    expect(md).toContain('**2026-10-30**')
  })

  it('falls back to the untitled label and skips empty messages', () => {
    const out = chatToMarkdown('  ', [{ id: 'x', role: 'assistant', text: '   ', reasoning: '', streaming: false, ts: 1 }], labels)

    expect(out.startsWith('# Sans titre\n')).toBe(true)
    expect(out).not.toContain('## Jarod')
  })
})

describe('exportFileName', () => {
  it('drops the characters Windows forbids and ends with the day', () => {
    expect(exportFileName('Compte rendu: "mars" / avril?', at(10, 0))).toBe('Compte rendu mars avril - 2026-10-31.md')
  })

  it('has a name when the title is empty, and a bounded length', () => {
    expect(exportFileName('', at(10, 0))).toBe('conversation - 2026-10-31.md')
    expect(exportFileName('é'.repeat(200), at(10, 0)).length).toBeLessThanOrEqual(60 + ' - 2026-10-31.md'.length)
  })

  it('does not leave a trailing dot or space before the day', () => {
    expect(exportFileName('Fin...  ', at(10, 0))).toBe('Fin - 2026-10-31.md')
  })
})

describe('hastText', () => {
  it('joins the text of a nested node', () => {
    const node = { type: 'element', children: [{ type: 'element', children: [{ type: 'text', value: 'const a' }, { type: 'text', value: ' = 1\n' }] }] }

    expect(hastText(node)).toBe('const a = 1\n')
  })

  it('is empty for anything that is not a node', () => {
    expect(hastText(undefined)).toBe('')
    expect(hastText('x')).toBe('')
    expect(hastText({ type: 'element' })).toBe('')
  })
})
