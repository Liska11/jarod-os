import { describe, expect, it } from 'vitest'
import { fieldProblem, type MessagingEnvVar, type MessagingPlatform, missingFields, stateOf, updateFromDraft, visibleVars } from './messaging-model.ts'

const variable = (over: Partial<MessagingEnvVar>): MessagingEnvVar => ({ key: 'TOKEN', description: '', prompt: 'Bot token', is_password: true, is_set: false, required: true, advanced: false, url: null, redacted_value: null, ...over })

describe('stateOf', () => {
  it('names the engine’s states, and falls back to the state text', () => {
    expect(stateOf({ state: 'connected', enabled: true })).toEqual({ label: 'Connected', tone: 'ok' })
    expect(stateOf({ state: 'not_configured', enabled: true })).toEqual({ label: 'Needs setup', tone: 'warn' })
    expect(stateOf({ state: 'gateway_stopped', enabled: true }).tone).toBe('warn')
    expect(stateOf({ state: 'error', enabled: true }).tone).toBe('danger')
    expect(stateOf({ state: null, enabled: false })).toEqual({ label: 'Off', tone: 'muted' })
    expect(stateOf({ state: undefined, enabled: true })).toEqual({ label: 'Ready', tone: 'info' })
    expect(stateOf({ state: 'rate_limited', enabled: true })).toEqual({ label: 'rate limited', tone: 'muted' })
  })
})

describe('visibleVars', () => {
  it('required first; advanced ones only when asked (a required advanced one always shows)', () => {
    const vars = [variable({ key: 'A', required: false }), variable({ key: 'B', required: true }), variable({ key: 'C', required: false, advanced: true }), variable({ key: 'D', required: true, advanced: true })]

    expect(visibleVars(vars, false).map(v => v.key)).toEqual(['B', 'D', 'A'])
    expect(visibleVars(vars, true).map(v => v.key)).toEqual(['B', 'D', 'A', 'C'])
  })
})

describe('updateFromDraft', () => {
  it('writes what was typed (trimmed), clears what was cleared, ignores empty boxes; nothing to send is null', () => {
    expect(updateFromDraft({ A: ' abc ', B: '', C: '   ' }, [])).toEqual({ env: { A: 'abc' } })
    expect(updateFromDraft({ A: 'x' }, ['B'])).toEqual({ env: { A: 'x' }, clear_env: ['B'] })
    expect(updateFromDraft({}, ['B'])).toEqual({ clear_env: ['B'] })
    expect(updateFromDraft({ A: '', B: ' ' }, [])).toBeNull()
  })

  it('a field that is both typed and cleared is cleared, not written', () => {
    expect(updateFromDraft({ A: 'typed' }, ['A'])).toEqual({ clear_env: ['A'] })
  })
})

describe('fieldProblem', () => {
  it('flags a secret with blanks or quotes, and an absurd length; other text is free', () => {
    expect(fieldProblem(variable({}), '123:abc-DEF')).toBeNull()
    expect(fieldProblem(variable({}), '123 abc')).toMatch(/Copy it again/)
    expect(fieldProblem(variable({}), '"123:abc"')).toMatch(/Copy it again/)
    expect(fieldProblem(variable({}), '123:abc\n')).toBeNull() // trimmed
    expect(fieldProblem(variable({ is_password: false }), 'imap.example.org')).toBeNull()
    expect(fieldProblem(variable({ is_password: false }), 'x'.repeat(2001))).toMatch(/too long/)
    expect(fieldProblem(variable({}), '')).toBeNull()
  })
})

describe('missingFields', () => {
  it('lists the required fields that are not set, by their prompt', () => {
    const platform = { env_vars: [variable({ key: 'A', prompt: 'Bot token' }), variable({ key: 'B', is_set: true }), variable({ key: 'C', required: false }), variable({ key: 'D', prompt: '' })] } as MessagingPlatform

    expect(missingFields(platform)).toEqual(['Bot token', 'D'])
  })
})
