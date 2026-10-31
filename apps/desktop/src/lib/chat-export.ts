import type { ChatMessage } from './chat-model.ts'

export interface ExportLabels {
  /** Heading of the person's messages. */
  you: string
  /** Heading of the assistant's messages. */
  assistant: string
  /** "Tool" in the language of the app, for the one-line mention of a tool call. */
  tool: string
  /** The line under the title, already formatted with the export date. */
  exportedOn: string
  /** The title of a conversation that has none. */
  untitled: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

const clock = (ts: number): string => {
  const d = new Date(ts)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const dayOf = (ts: number): string => {
  const d = new Date(ts)

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The conversation as a Markdown document: a heading per message, the text as written, one italic line per tool call. */
export function chatToMarkdown(title: string, messages: readonly ChatMessage[], labels: ExportLabels): string {
  const out: string[] = [`# ${title.trim() || labels.untitled}`, '', `_${labels.exportedOn}_`]
  let day = ''

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push('', `_${labels.tool} : ${message.name}_`)

      continue
    }

    const text = message.text.trim()

    if (!text) {
      continue
    }

    if (dayOf(message.ts) !== day) {
      day = dayOf(message.ts)
      out.push('', `---`, '', `**${day}**`)
    }

    if (message.role === 'system') {
      out.push('', `> ${text.replace(/\n/g, '\n> ')}`)

      continue
    }

    out.push('', `## ${message.role === 'user' ? labels.you : labels.assistant} · ${clock(message.ts)}`, '', text)
  }

  return `${out.join('\n')}\n`
}

/** A file name safe on Windows, macOS and Linux: the title without forbidden characters, then the day. */
export function exportFileName(title: string, ts: number, extension = 'md'): string {
  const base = title
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60)
    .trim()

  return `${base || 'conversation'} - ${dayOf(ts)}.${extension}`
}

/** The text inside a Markdown syntax-tree node (what a code block holds), for the button that copies it. */
export function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const { type, value, children } = node as { type?: string; value?: unknown; children?: unknown }

  if (type === 'text' && typeof value === 'string') {
    return value
  }

  return Array.isArray(children) ? children.map(hastText).join('') : ''
}
