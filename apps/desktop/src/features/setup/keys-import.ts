/*
 * The first-run API keys import (HANDOFF.md, section 7, step 2): a `.txt` the person provides, one `NAME=key` per line.
 * Parsing is lenient on the form (blank lines, `#` or `//` comments, `export NAME=…`, spaces around `=`, quotes) and
 * strict on the content: a valid variable name, a value without spaces, the known prefix of the service when there is
 * one. A name given twice keeps its last line; the earlier ones are marked replaced. A bad line can be corrected in
 * place and parsed again.
 *
 * Each key then goes where the engine keeps it: a model provider's key through `set-env` (its encrypted store), a
 * messaging token through `update-messaging-platform`, anything else into the vault (`vault-save`), named after the
 * variable, usable by the agent's tools but never shown back.
 */

export type LineStatus = 'ok' | 'invalid' | 'replaced' | 'skipped'
export type Destination = 'provider' | 'messaging' | 'vault'

export interface KeyLine {
  /** 1-based line number in the file. */
  line: number
  raw: string
  name: string
  value: string
  status: LineStatus
  /** Why the line is invalid, or which line replaced it. */
  problem?: string
  destination?: Destination
  /** The name as written, when it was read as another one (`CLAUDE_API_KEY` → `ANTHROPIC_API_KEY`). */
  renamedFrom?: string
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** Model providers the engine knows by these names (`set-env`; bridge `providers.ts` and `url-key-map.ts`). */
export const PROVIDER_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'NVIDIA_API_KEY',
  'GLM_API_KEY',
  'MINIMAX_API_KEY',
  'NOUS_API_KEY',
  'HERMESONE_API_KEY',
  'OLLAMA_API_KEY',
  'AIMLAPI_API_KEY',
  'HF_TOKEN',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY',
  'ATLASCLOUD_API_KEY',
  'MISTRAL_API_KEY',
  'PERPLEXITY_API_KEY',
  'XIAOMI_API_KEY',
  'DASHSCOPE_API_KEY',
  'CUSTOM_API_KEY'
])

/** Messaging tokens → the channel that holds them (`update-messaging-platform`). */
export const MESSAGING_KEYS: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: 'telegram',
  DISCORD_BOT_TOKEN: 'discord',
  SLACK_BOT_TOKEN: 'slack',
  SLACK_APP_TOKEN: 'slack',
  EMAIL_PASSWORD: 'email'
}

/** The shape a service's keys have, when it is well known: [pattern, what it should look like]. */
const FORMATS: Record<string, [RegExp, string]> = {
  OPENAI_API_KEY: [/^sk-[A-Za-z0-9_-]{20,}$/, 'sk-…'],
  ANTHROPIC_API_KEY: [/^sk-ant-[A-Za-z0-9_-]{20,}$/, 'sk-ant-…'],
  OPENROUTER_API_KEY: [/^sk-or-[A-Za-z0-9_-]{20,}$/, 'sk-or-…'],
  GROQ_API_KEY: [/^gsk_[A-Za-z0-9]{20,}$/, 'gsk_…'],
  HF_TOKEN: [/^hf_[A-Za-z0-9]{20,}$/, 'hf_…'],
  GOOGLE_API_KEY: [/^AIza[A-Za-z0-9_-]{30,}$/, 'AIza…'],
  XAI_API_KEY: [/^xai-[A-Za-z0-9]{20,}$/, 'xai-…'],
  PERPLEXITY_API_KEY: [/^pplx-[A-Za-z0-9]{20,}$/, 'pplx-…'],
  TELEGRAM_BOT_TOKEN: [/^\d{5,}:[A-Za-z0-9_-]{30,}$/, '123456789:AA…'],
  SLACK_BOT_TOKEN: [/^xoxb-[A-Za-z0-9-]+$/, 'xoxb-…'],
  SLACK_APP_TOKEN: [/^xapp-[A-Za-z0-9-]+$/, 'xapp-…']
}

/**
 * Names people commonly give a provider's key, read as the name the engine knows. Without this, `CLAUDE_API_KEY=…` was
 * accepted but stored in the vault, where the provider never looks: a silent miss.
 */
const ALIASES: Record<string, string> = {
  OPENAI_KEY: 'OPENAI_API_KEY',
  OPENAI_TOKEN: 'OPENAI_API_KEY',
  CHATGPT_API_KEY: 'OPENAI_API_KEY',
  ANTHROPIC_KEY: 'ANTHROPIC_API_KEY',
  CLAUDE_API_KEY: 'ANTHROPIC_API_KEY',
  CLAUDE_KEY: 'ANTHROPIC_API_KEY',
  OPENROUTER_KEY: 'OPENROUTER_API_KEY',
  GEMINI_API_KEY: 'GOOGLE_API_KEY',
  GEMINI_KEY: 'GOOGLE_API_KEY',
  GOOGLE_GEMINI_API_KEY: 'GOOGLE_API_KEY',
  GROK_API_KEY: 'XAI_API_KEY',
  XAI_KEY: 'XAI_API_KEY',
  GROQ_KEY: 'GROQ_API_KEY',
  MISTRAL_KEY: 'MISTRAL_API_KEY',
  DEEPSEEK_KEY: 'DEEPSEEK_API_KEY',
  PERPLEXITY_KEY: 'PERPLEXITY_API_KEY',
  HUGGINGFACE_TOKEN: 'HF_TOKEN',
  HUGGING_FACE_TOKEN: 'HF_TOKEN',
  HUGGINGFACE_API_KEY: 'HF_TOKEN',
  HF_API_KEY: 'HF_TOKEN',
  TELEGRAM_TOKEN: 'TELEGRAM_BOT_TOKEN',
  DISCORD_TOKEN: 'DISCORD_BOT_TOKEN'
}

export function destinationOf(name: string): Destination {
  if (PROVIDER_KEYS.has(name)) return 'provider'
  if (name in MESSAGING_KEYS) return 'messaging'
  return 'vault'
}

/** Zero-width characters and the byte-order mark: invisible, and a copy from a web page often carries them. */
const INVISIBLE = /[​-‍⁠﻿]/g

const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '”': '”', '‘': '’', '’': '’', '«': '»' }

function unquote(value: string): string {
  let v = value.trim()
  const close = QUOTES[v[0] ?? '']
  if (close && v.length >= 2) {
    const end = v.indexOf(close, 1)
    // a quoted value: what is inside the quotes; anything after them can only be a comment
    if (end > 0) return v.slice(1, end).trim()
  }
  // an unquoted value: `# …` after a space is a comment
  v = v.replace(/\s+#.*$/, '')
  return v.trim()
}

/** A name as written (`OpenAI API Key`, `groq-api-key`) → the variable form (`OPENAI_API_KEY`), then its usual name. */
function normalName(written: string): { name: string; renamedFrom?: string } {
  const plain = written
    .trim()
    .replace(/[\s.-]+/g, '_')
    .toUpperCase()
  const known = ALIASES[plain]

  if (known) return { name: known, renamedFrom: plain }
  // A variable name cannot start with a digit, but some services do (1min.ai, 1fichier): read under KEY_<name>.
  if (/^\d/.test(plain)) return { name: `KEY_${plain}`, renamedFrom: plain }

  return { name: plain }
}

/**
 * Keys whose prefix belongs to one service only, checked in this order (sk-ant- before anything else that starts with sk-).
 * A bare `sk-` is not here: OpenAI, DeepSeek and others share it.
 */
const SHAPES = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'HF_TOKEN', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'PERPLEXITY_API_KEY', 'TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const

/** The service a key belongs to by its shape alone, or null. */
export function serviceOfValue(value: string): string | null {
  return SHAPES.find(name => FORMATS[name]?.[0].test(value)) ?? null
}

/**
 * A key that would go to the vault but whose shape names one service (`OPENROUTEUR=sk-or-…`) goes to that service instead,
 * marked as read from its name. Only when it is the file's one key of that shape and nothing in the file names the service
 * already: otherwise one key would silently replace another, and the person chooses.
 */
export function routeByShape(lines: readonly KeyLine[]): KeyLine[] {
  const named = new Set(lines.filter(entry => entry.status === 'ok' && entry.destination !== 'vault').map(entry => entry.name))
  const byService = new Map<string, KeyLine[]>()

  for (const entry of lines) {
    if (entry.status !== 'ok' || entry.destination !== 'vault') continue
    const service = serviceOfValue(entry.value)
    if (service) byService.set(service, [...(byService.get(service) ?? []), entry])
  }

  const moved = new Map<number, string>()
  for (const [service, entries] of byService) {
    if (entries.length === 1 && !named.has(service)) moved.set(entries[0].line, service)
  }

  return lines.map(entry => {
    const service = moved.get(entry.line)
    return service ? { ...entry, name: service, renamedFrom: entry.renamedFrom ?? entry.name, destination: destinationOf(service) } : entry
  })
}

/** The file's lines judged together: keys recognised by their shape, then duplicates (the last valid line of a name wins). */
export function settleLines(lines: readonly KeyLine[]): KeyLine[] {
  return markReplaced(routeByShape(lines))
}

/** One line of the file: skipped (blank, comment), ok, or invalid with the reason. */
export function parseLine(raw: string, line: number): KeyLine {
  const text = raw.replace(INVISIBLE, '').trim()
  if (!text || text.startsWith('#') || text.startsWith('//')) return { line, raw, name: '', value: '', status: 'skipped' }
  const body = text.replace(/^export\s+/, '')
  // `NAME=value`, or `NAME: value` (a notes or YAML habit): the first separator that comes after a name.
  const eq = body.indexOf('=')
  const colon = body.indexOf(':')
  const at = eq > 0 && (colon <= 0 || eq < colon) ? eq : colon > 0 ? colon : -1
  if (at <= 0) return { line, raw, name: '', value: '', status: 'invalid', problem: 'missing-equals' }
  const { name, renamedFrom } = normalName(body.slice(0, at))
  const value = unquote(body.slice(at + 1))
  const base = { line, raw, name, value, ...(renamedFrom ? { renamedFrom } : {}) }
  if (!NAME.test(name)) return { ...base, status: 'invalid', problem: 'bad-name' }
  if (!value) return { ...base, status: 'invalid', problem: 'empty-value' }
  if (/\s/.test(value)) return { ...base, status: 'invalid', problem: 'spaces' }
  const format = FORMATS[name]
  if (format && !format[0].test(value)) return { ...base, status: 'invalid', problem: `format:${format[1]}`, destination: destinationOf(name) }
  return { ...base, status: 'ok', destination: destinationOf(name) }
}

/** The whole file; duplicates keep their last valid line, earlier ones are marked `replaced` by it. */
export function parseKeysFile(text: string): KeyLine[] {
  return settleLines(
    text
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .map((raw, index) => parseLine(raw, index + 1))
  )
}

/** Judge duplicates again over parsed lines (after one was corrected): the last valid line of a name wins. */
export function markReplaced(lines: readonly KeyLine[]): KeyLine[] {
  const fresh = lines.map(entry => (entry.status === 'replaced' ? { ...entry, status: 'ok' as const, problem: undefined } : entry))
  const last = new Map<string, number>()
  for (const entry of fresh) if (entry.status === 'ok') last.set(entry.name, entry.line)
  return fresh.map(entry => {
    const winner = last.get(entry.name)
    return entry.status === 'ok' && winner !== undefined && winner !== entry.line ? { ...entry, status: 'replaced' as const, problem: String(winner) } : entry
  })
}

/** What gets imported: the valid lines, one per name. */
export function importable(lines: readonly KeyLine[]): KeyLine[] {
  return lines.filter(entry => entry.status === 'ok')
}

/** A key as the screen shows it: its first characters, never the whole value. */
export function maskValue(value: string): string {
  return value.length <= 8 ? '••••••' : `${value.slice(0, 4)}••••••${value.slice(-2)}`
}
