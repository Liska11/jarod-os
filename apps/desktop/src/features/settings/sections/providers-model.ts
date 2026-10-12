/*
 * Providers & keys: the data side of the section (no React). The Jarod engine serves `/api/jarod/providers`; a key goes in and never comes
 * back, so a row only says whether one is saved. Client checks here mirror the engine's (the engine stays the authority) to answer at once.
 */

export interface ProviderRow {
  id: string
  name: string
  protocol: string
  base_url: string
  local: boolean
  models: string[]
  key_url: string | null
  has_key: boolean
  /** Where the key comes from: this app's encrypted store, or an environment variable of the engine (named in `env_var`; nothing to remove here). */
  key_source: 'vault' | 'env' | null
  env_var: string | null
  extra_keys: number
  configured: boolean
  active: boolean
}

export interface ProvidersPayload {
  providers: ProviderRow[]
  active: { provider: string; model: string }
}

export interface ProviderTestResult {
  ok: boolean
  models: number
  error?: string
}

export type ProviderState = 'ready' | 'needs-key' | 'local'

/** `ready`: a key is saved; `local`: a server on this PC (works without a key, a key is optional); `needs-key`: cloud provider with no key yet. */
export function providerState(row: ProviderRow): ProviderState {
  if (row.has_key) {
    return 'ready'
  }

  return row.local ? 'local' : 'needs-key'
}

export function providerSummary(row: ProviderRow): string {
  const models = row.models.length === 0 ? 'models listed by the server' : `${row.models.length} model${row.models.length === 1 ? '' : 's'}`
  const extra = row.extra_keys > 0 ? ` · +${row.extra_keys} backup key${row.extra_keys === 1 ? '' : 's'}` : ''

  switch (providerState(row)) {
    case 'ready':
      return row.key_source === 'env' ? `Key from the ${row.env_var ?? 'environment'} variable · ${models}${extra}` : `Key saved · ${models}${extra}`
    case 'local':
      return `${row.base_url} · ${models}`
    default:
      return `No key yet · ${models}`
  }
}

/** Cloud providers first (those still missing a key on top), then the servers on this PC; each group by name. */
export function groupProviders(rows: readonly ProviderRow[]): { cloud: ProviderRow[]; local: ProviderRow[] } {
  const byName = (a: ProviderRow, b: ProviderRow) => a.name.localeCompare(b.name)
  const rank = (row: ProviderRow) => (row.has_key ? 0 : 1)
  const cloud = rows.filter(row => !row.local).sort((a, b) => rank(a) - rank(b) || byName(a, b))
  const local = rows.filter(row => row.local).sort(byName)

  return { cloud, local }
}

const MAX_KEY_CHARS = 2048

/** Why a pasted key will be refused (same rules as the engine), or null when it looks fine. Never echoes the key. */
export function keyProblem(value: string): string | null {
  const key = value.trim()

  if (!key) {
    return 'Paste the key first.'
  }

  if (key.length > MAX_KEY_CHARS) {
    return 'That is too long to be a key.'
  }

  if (/[\s"'`]/.test(key) || /[^\x21-\x7e]/.test(key)) {
    return 'The key has a space, a quote or an unusual character. Copy it again, with nothing around it.'
  }

  return null
}

/** Why an address will be refused, or null (empty is fine: it restores the default). */
export function addressProblem(value: string): string | null {
  const text = value.trim()

  if (!text) {
    return null
  }

  let url: URL

  try {
    url = new URL(text)
  } catch {
    return 'Use a full address, like http://127.0.0.1:1234/v1.'
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The address must start with http:// or https://.'
  }

  if (url.username || url.password) {
    return 'Do not put a login in the address; save the key separately.'
  }

  return null
}

/** Is this a "the engine has no such route" failure (a Hermes backend, or an older engine)? */
export function isUnsupported(message: string | null | undefined): boolean {
  return Boolean(message && /404|not implemented|not found/i.test(message))
}
