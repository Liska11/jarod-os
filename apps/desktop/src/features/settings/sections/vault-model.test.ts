import { describe, expect, it } from 'vitest'
import { en } from '../../../locales/en.ts'
import { fr } from '../../../locales/fr.ts'
import { draftOf, emptyVault, MAX_VALUE, parseDomains, protectionNote, reachText, savePayload, vaultProblems } from './vault-model.ts'

describe('protectionNote', () => {
  it('DPAPI key: the normal state, said plainly', () => {
    expect(protectionNote({ protection: 'os-key', encrypted: true, keyStore: 'dpapi' }, null, false)).toEqual({ tone: 'info', key: 'dpapi' })
    expect(protectionNote({ protection: 'os-key', encrypted: true, keyStore: 'keychain' }, null, false)).toEqual({ tone: 'info', key: 'os' })
  })

  it('key-file fallback: a warning', () => {
    expect(protectionNote({ protection: 'weak', encrypted: true, keyStore: 'file' }, null, false)).toEqual({ tone: 'warn', key: 'weak' })
  })

  it('clear database: danger', () => {
    expect(protectionNote({ protection: 'plain', encrypted: false, keyStore: null }, null, false)).toEqual({ tone: 'danger', key: 'plain' })
  })

  it('unknown, unreadable or from an older engine: unknown, never guessed from the other fields', () => {
    expect(protectionNote({ protection: 'unknown', encrypted: true, keyStore: 'memory' }, null, false)).toEqual({ tone: 'warn', key: 'unknown' })
    expect(protectionNote(null, 'unsupported channel vault-status', false)).toEqual({ tone: 'warn', key: 'unknown' })
    // Older engine answer (encrypted + keyStore, no `protection`): not read as protected.
    expect(protectionNote({ encrypted: true, keyStore: 'dpapi' }, null, false)).toEqual({ tone: 'warn', key: 'unknown' })
    expect(protectionNote({ protection: 'os-key' }, 'boom', false)).toEqual({ tone: 'warn', key: 'unknown' })
    expect(protectionNote(null, null, false)).toEqual({ tone: 'warn', key: 'unknown' })
  })

  it('nothing while the first answer is awaited', () => {
    expect(protectionNote(null, null, true)).toBeNull()
  })

  it('every state has a sentence in both languages; the weak one says what to do', () => {
    for (const key of ['dpapi', 'os', 'weak', 'plain', 'unknown'] as const) {
      expect(en[`settings.vault.status.${key}`]).toBeTruthy()
      expect(fr[`settings.vault.status.${key}`]).toBeTruthy()
    }
    expect(fr['settings.vault.status.weak']).toMatch(/db\.key/)
    expect(fr['settings.vault.status.weak']).toMatch(/Pour revenir à DPAPI/)
    expect(en['settings.vault.status.weak']).toMatch(/To go back to DPAPI/)
  })
})

const ok = { ...emptyVault(), name: 'GithubToken', value: 'ghp_x', domains: 'api.github.com' }

describe('parseDomains', () => {
  it('splits on blanks, commas, semicolons and lines; lower-cases; drops duplicates and empties', () => {
    expect(parseDomains('API.github.com, github.com;\n*.example.org  api.github.com ')).toEqual(['api.github.com', 'github.com', '*.example.org'])
    expect(parseDomains('  ')).toEqual([])
  })
})

describe('vaultProblems', () => {
  it('a complete new secret is fine; an existing one needs no value', () => {
    expect(vaultProblems(ok, true, [])).toEqual([])
    expect(vaultProblems({ ...ok, value: '' }, false, ['GithubToken'])).toEqual([])
  })

  it('names each problem: name, duplicate (new only), variable, domains, value', () => {
    expect(vaultProblems({ ...ok, name: '1x' }, true, [])[0]).toMatch(/^Name/)
    expect(vaultProblems(ok, true, ['GithubToken'])).toEqual(['A secret called “GithubToken” already exists.'])
    expect(vaultProblems({ ...ok, envVar: '9X' }, true, [])).toEqual(['Variable: letters, digits and _, not starting with a digit.'])
    expect(vaultProblems({ ...ok, domains: 'https://x.org/path' }, true, [])[0]).toMatch(/is not a domain/)
    expect(vaultProblems({ ...ok, domains: 'x.org:8080' }, true, [])[0]).toMatch(/is not a domain/)
    expect(vaultProblems({ ...ok, domains: Array.from({ length: 21 }, (_, i) => `d${i}.org`).join(' ') }, true, [])).toEqual(['At most 20 domains.'])
    expect(vaultProblems({ ...ok, value: '' }, true, [])).toEqual(['Value: a new secret needs one.'])
    expect(vaultProblems({ ...ok, value: 'x'.repeat(MAX_VALUE + 1) }, true, [])[0]).toMatch(/characters at most/)
    expect(vaultProblems({ ...ok, description: 'x'.repeat(301) }, true, [])).toEqual(['Description: 300 characters at most.'])
  })

  it('accepts *.domain, localhost and a plain domain', () => {
    expect(vaultProblems({ ...ok, domains: '*.example.org localhost api.test.io' }, true, [])).toEqual([])
  })
})

describe('payload and summaries', () => {
  it('sends the entry and a value only when typed; an edit draft starts without the value', () => {
    expect(savePayload({ ...ok, description: ' tok ', envVar: ' GH ', allowShell: true })).toEqual({ entry: { name: 'GithubToken', description: 'tok', envVar: 'GH', domains: ['api.github.com'], allowShell: true, kind: 'api_key', temporary: false }, value: 'ghp_x' })
    expect(savePayload({ ...ok, value: '' }).value).toBeUndefined()
    expect('envVar' in savePayload(ok).entry).toBe(false)
    expect(draftOf({ name: 'A', description: 'd', envVar: 'E', domains: ['x.org', 'y.org'], allowShell: true, createdAt: 1, hasValue: true })).toEqual({ name: 'A', description: 'd', envVar: 'E', domains: 'x.org\ny.org', allowShell: true, value: '', kind: 'other', temporary: false })
  })

  it('says where a secret may be used', () => {
    expect(reachText({ domains: ['api.github.com'], allowShell: false, envVar: '' })).toBe('sent only to api.github.com')
    expect(reachText({ domains: [], allowShell: true, envVar: 'GH' })).toBe('in shell commands as GH')
    expect(reachText({ domains: ['a.org'], allowShell: true, envVar: '' })).toBe('sent only to a.org · in shell commands')
    expect(reachText({ domains: [], allowShell: false, envVar: '' })).toBe('not usable anywhere yet')
  })
})
