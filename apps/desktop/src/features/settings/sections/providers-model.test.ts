import { describe, expect, it } from 'vitest'
import { addressProblem, groupProviders, isUnsupported, keyProblem, type ProviderRow, providerState, providerSummary } from './providers-model.ts'

const row = (over: Partial<ProviderRow>): ProviderRow => ({
  id: 'openai',
  name: 'OpenAI',
  protocol: 'openai',
  base_url: 'https://api.openai.com/v1',
  local: false,
  models: ['gpt-x', 'gpt-y'],
  key_url: null,
  has_key: false,
  key_source: null,
  env_var: null,
  extra_keys: 0,
  configured: false,
  active: false,
  ...over
})

describe('providerState / providerSummary', () => {
  it('a saved key is ready; a server on this PC works without one; a cloud provider without a key needs one', () => {
    expect(providerState(row({ has_key: true }))).toBe('ready')
    expect(providerState(row({ local: true }))).toBe('local')
    expect(providerState(row({ local: true, has_key: true }))).toBe('ready')
    expect(providerState(row({}))).toBe('needs-key')
  })

  it('says what is known without ever carrying a key, and pluralises', () => {
    expect(providerSummary(row({ has_key: true, extra_keys: 2 }))).toBe('Key saved · 2 models · +2 backup keys')
    expect(providerSummary(row({ has_key: true, models: ['m'], extra_keys: 1 }))).toBe('Key saved · 1 model · +1 backup key')
    expect(providerSummary(row({ local: true, base_url: 'http://127.0.0.1:1234/v1', models: [] }))).toBe('http://127.0.0.1:1234/v1 · models listed by the server')
    expect(providerSummary(row({}))).toBe('No key yet · 2 models')
    expect(providerSummary(row({ has_key: true, key_source: 'env', env_var: 'OPENAI_API_KEY' }))).toBe('Key from the OPENAI_API_KEY variable · 2 models')
  })
})

describe('groupProviders', () => {
  it('splits cloud from local, puts providers that still need a key first, then sorts by name', () => {
    const rows = [row({ id: 'b', name: 'B', has_key: true }), row({ id: 'a', name: 'A' }), row({ id: 'c', name: 'C' }), row({ id: 'l2', name: 'Zed', local: true }), row({ id: 'l1', name: 'Alpha', local: true })]
    const { cloud, local } = groupProviders(rows)

    expect(cloud.map(r => r.id)).toEqual(['b', 'a', 'c'])
    expect(local.map(r => r.id)).toEqual(['l1', 'l2'])
  })
})

describe('keyProblem', () => {
  it('accepts a plain key, with surrounding blanks trimmed', () => {
    expect(keyProblem('  abc-DEF_123.456~xyz=\n')).toBeNull()
  })

  it('refuses empty, blank, inner spaces, quotes, non-printable and oversize values, and never repeats the value', () => {
    for (const bad of ['', '   ', 'ab cd', 'ab"cd', "ab'cd", 'ab`cd', 'clé', 'a\u0000b', 'x'.repeat(2049)]) {
      const problem = keyProblem(bad)

      expect(problem, JSON.stringify(bad.slice(0, 12))).toBeTruthy()
      expect(problem).not.toContain(bad.trim() || '\u0001')
    }
  })
})

describe('addressProblem', () => {
  it('empty restores the default; http(s) addresses pass', () => {
    expect(addressProblem('')).toBeNull()
    expect(addressProblem(' http://127.0.0.1:1234/v1 ')).toBeNull()
    expect(addressProblem('https://example.org')).toBeNull()
  })

  it('refuses other schemes, logins in the address and nonsense', () => {
    expect(addressProblem('ftp://x')).toMatch(/http/)
    expect(addressProblem('javascript:alert(1)')).toMatch(/http/)
    expect(addressProblem('http://user:pass@host/v1')).toMatch(/login/)
    expect(addressProblem('not an address')).toMatch(/full address/)
  })
})

describe('isUnsupported', () => {
  it('recognises a backend without the route', () => {
    expect(isUnsupported('404 not implemented by the Jarod gateway: GET /api/jarod/providers')).toBe(true)
    expect(isUnsupported('Not Found')).toBe(true)
    expect(isUnsupported('connection refused')).toBe(false)
    expect(isUnsupported(null)).toBe(false)
  })
})
