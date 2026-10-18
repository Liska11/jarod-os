/*
 * Secrets vault: values the agent can USE without ever seeing them (an API key sent to chosen domains, an environment variable in shell commands).
 * Mirrors `vault-list`, `vault-save`, `vault-remove`; the engine confirms by native dialog whenever a secret gains reach.
 */

export interface VaultEntry {
  name: string
  description: string
  envVar: string
  domains: string[]
  allowShell: boolean
  createdAt: number
  hasValue: boolean
  /** What it is (absent on an older engine: other). */
  kind?: VaultKind
  /** Held in the engine's memory only, gone at its next start. */
  temporary?: boolean
}

export type VaultKind = 'api_key' | 'token' | 'password' | 'other'
export const VAULT_KINDS: VaultKind[] = ['api_key', 'token', 'password', 'other']

/** How the vault is kept on this disk (`vault-status`). */
export interface VaultStatus {
  encrypted: boolean
  keyStore: 'dpapi' | 'file' | 'other' | null
}

export interface VaultDraft {
  name: string
  description: string
  envVar: string
  /** Domains, separated by spaces, commas or line breaks. */
  domains: string
  allowShell: boolean
  value: string
  kind: VaultKind
  temporary: boolean
}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const DOMAIN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/
export const MAX_VALUE = 20_000

export const emptyVault = (): VaultDraft => ({ name: '', description: '', envVar: '', domains: '', allowShell: false, value: '', kind: 'api_key', temporary: false })

export function draftOf(entry: VaultEntry): VaultDraft {
  return { name: entry.name, description: entry.description, envVar: entry.envVar, domains: entry.domains.join('\n'), allowShell: entry.allowShell, value: '', kind: entry.kind ?? 'other', temporary: Boolean(entry.temporary) }
}

export function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(d => d.trim().toLowerCase()).filter(Boolean))]
}

/** Reasons the draft would be refused. `isNew`: a new secret needs a value. */
export function vaultProblems(draft: VaultDraft, isNew: boolean, existing: readonly string[]): string[] {
  const out: string[] = []
  const name = draft.name.trim()

  if (!NAME.test(name)) {
    out.push('Name: a letter, then letters, digits or _ (64 at most).')
  } else if (isNew && existing.includes(name)) {
    out.push(`A secret called “${name}” already exists.`)
  }

  if (draft.description.trim().length > 300) {
    out.push('Description: 300 characters at most.')
  }

  if (draft.envVar.trim() && !ENV.test(draft.envVar.trim())) {
    out.push('Variable: letters, digits and _, not starting with a digit.')
  }

  const domains = parseDomains(draft.domains)

  if (domains.length > 20) {
    out.push('At most 20 domains.')
  }

  for (const domain of domains) {
    if (!DOMAIN.test(domain)) {
      out.push(`“${domain.slice(0, 40)}” is not a domain (no scheme, path or port; *.example.org is allowed).`)
      break
    }
  }

  if (draft.value.length > MAX_VALUE) {
    out.push(`Value: ${MAX_VALUE.toLocaleString('en-US')} characters at most.`)
  }

  if (isNew && !draft.value) {
    out.push('Value: a new secret needs one.')
  }

  return out
}

/** What `vault-save` receives: the entry, and the value only when one was typed (an empty box keeps the saved value). */
export function savePayload(draft: VaultDraft): { entry: Record<string, unknown>; value: string | undefined } {
  return {
    entry: { name: draft.name.trim(), description: draft.description.trim(), ...(draft.envVar.trim() ? { envVar: draft.envVar.trim() } : {}), domains: parseDomains(draft.domains), allowShell: draft.allowShell, kind: draft.kind, temporary: draft.temporary },
    value: draft.value ? draft.value : undefined
  }
}

/** Where the secret may be used, in words. */
export function reachText(entry: Pick<VaultEntry, 'domains' | 'allowShell' | 'envVar'>): string {
  const parts: string[] = []

  if (entry.domains.length > 0) {
    parts.push(`sent only to ${entry.domains.join(', ')}`)
  }

  if (entry.allowShell) {
    parts.push(`in shell commands${entry.envVar ? ` as ${entry.envVar}` : ''}`)
  }

  return parts.length > 0 ? parts.join(' · ') : 'not usable anywhere yet'
}
