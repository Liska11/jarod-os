/*
 * MCP servers: the data side of the section. Mirrors `list-mcp-servers`, `add-mcp-server`, `update-mcp-server`.
 * Environment values are secrets: the engine returns "••••••••" for each, and a form that sends the mask back means "keep what is saved".
 */

export const SECRET_MASK = '••••••••'

export interface McpServer {
  name: string
  type: 'http' | 'stdio' | 'unknown'
  enabled: boolean
  detail: string
  url?: string
  command?: string
  args: string[]
  env: Record<string, string>
}

export interface McpDraft {
  name: string
  type: 'http' | 'stdio'
  url: string
  command: string
  /** One argument per line. */
  args: string
  /** One `NAME=value` per line. */
  env: string
}

export interface McpInput {
  name: string
  type: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export const emptyDraft = (): McpDraft => ({ name: '', type: 'stdio', url: '', command: '', args: '', env: '' })

/**
 * Cockpit, lot 3: context-mode (mksglu/context-mode, ELv2) as a Jarod MCP server, pinned to the version of the audited commit (b31c7ee = 1.0.169).
 * Only a pre-filled form: nothing is added until the person saves it, and npx downloads the package from npm when the server first starts.
 */
export const CONTEXT_MODE_VERSION = '1.0.169'
export const contextModeDraft = (): McpDraft => ({ name: 'context-mode', type: 'stdio', url: '', command: 'npx', args: `-y
context-mode@${CONTEXT_MODE_VERSION}`, env: '' })

export function draftOf(server: McpServer): McpDraft {
  return {
    name: server.name,
    type: server.type === 'http' ? 'http' : 'stdio',
    url: server.url ?? '',
    command: server.command ?? '',
    args: server.args.join('\n'),
    // Existing secrets come back masked: keep the mask so saving without touching a value keeps it.
    env: Object.entries(server.env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Parse the env text: one NAME=value per line (the first `=` splits; a value may contain `=`). Lines without a name are errors. */
export function parseEnv(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {}

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()

    if (!line) {
      continue
    }

    const at = line.indexOf('=')
    const key = (at < 0 ? line : line.slice(0, at)).trim()

    if (at < 0 || !ENV_NAME.test(key)) {
      return { env, error: `“${line.slice(0, 40)}” is not NAME=value.` }
    }

    env[key] = line.slice(at + 1)
  }

  return { env, error: null }
}

/** Every reason the draft would be refused, in field order. */
export function draftProblems(draft: McpDraft, existing: readonly string[], original?: string): string[] {
  const out: string[] = []
  const name = draft.name.trim()

  if (!NAME.test(name)) {
    out.push('Name: start with a letter or digit, then letters, digits, _ or -.')
  } else if (name !== original && existing.includes(name)) {
    out.push(`A server called “${name}” already exists.`)
  }

  if (draft.type === 'http') {
    if (!/^https?:\/\//i.test(draft.url.trim())) {
      out.push('URL: it must start with http:// or https://.')
    }
  } else {
    if (!draft.command.trim()) {
      out.push('Command: the program to start, like npx or uvx.')
    }

    const parsed = parseEnv(draft.env)

    if (parsed.error) {
      out.push(`Environment: ${parsed.error}`)
    }
  }

  return out
}

export function inputOf(draft: McpDraft): McpInput {
  if (draft.type === 'http') {
    return { name: draft.name.trim(), type: 'http', url: draft.url.trim() }
  }

  return {
    name: draft.name.trim(),
    type: 'stdio',
    command: draft.command.trim(),
    args: draft.args.split(/\r?\n/).map(a => a.trim()).filter(Boolean),
    env: parseEnv(draft.env).env
  }
}

/** The environment lines to show in a summary: names only, never values. */
export function envNames(server: McpServer): string[] {
  return Object.keys(server.env)
}

export function describeServer(server: McpServer): string {
  if (server.type === 'http') {
    return server.url ?? server.detail
  }

  return [server.command, ...server.args].filter(Boolean).join(' ') || server.detail
}
