import { describe, expect, it } from 'vitest'
import { rateProblem, speechSummary } from './speech-model.ts'
import { engineKindOf } from '../../../store/engine.ts'

describe('speechSummary', () => {
  it('says where the voice goes, and asks for a key when the service has none', () => {
    const base = { id: 'x', name: 'X', defaultModel: 'm' }

    expect(speechSummary({ ...base, local: true, configured: true })).toBe('Runs on this PC: your voice stays here.')
    expect(speechSummary({ ...base, local: false, configured: true })).toBe('Hosted: each recording is sent to it.')
    expect(speechSummary({ ...base, local: false, configured: false })).toBe('Hosted: each recording is sent to it. It needs an API key (Settings → Providers & keys).')
    expect(speechSummary(undefined)).toBe('Which service turns your voice into text.')
  })
})

describe('rateProblem', () => {
  it('accepts 0.25 to 4 with decimals, refuses the rest', () => {
    for (const ok of ['1', '1.25', '0.25', '4', ' 2 ']) expect(rateProblem(ok), ok).toBeNull()
    for (const bad of ['0.2', '4.1', '', 'fast', '1,5', '-1']) expect(rateProblem(bad), bad).toBeTruthy()
  })
})

describe('engineKindOf', () => {
  it('reads /api/status: the Jarod core says so, anything else is Hermes, no answer is unknown', () => {
    expect(engineKindOf({ backend: 'jarod' })).toBe('jarod')
    expect(engineKindOf({})).toBe('hermes')
    expect(engineKindOf({ backend: 'x' })).toBe('hermes')
    expect(engineKindOf(null)).toBeNull()
  })
})
