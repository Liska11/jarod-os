// Lot 5 (Mark-LVI « Audio Device Picker » / « Prove It Hears You »).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { levelOf, micConstraints, preferredInputId, setPreferredInputId } from './audio-devices.ts'

// L'environnement de test n'a pas de localStorage : un stockage en mémoire en tient lieu.
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
})
afterEach(() => vi.unstubAllGlobals())

describe('micro choisi', () => {
  it('se garde et se retrouve ; vide = le défaut de Windows', () => {
    expect(preferredInputId()).toBe('')
    setPreferredInputId('abc')
    expect(preferredInputId()).toBe('abc')
    setPreferredInputId('')
    expect(preferredInputId()).toBe('')
  })

  it('les contraintes visent le micro choisi seulement s’il existe encore', () => {
    expect(micConstraints('abc', ['abc', 'def']).deviceId).toEqual({ exact: 'abc' })
    expect(micConstraints('abc', ['def']).deviceId).toBeUndefined()
    expect(micConstraints('', ['abc']).deviceId).toBeUndefined()
    expect(micConstraints('abc', null).deviceId).toEqual({ exact: 'abc' })
    expect(micConstraints('', null)).toMatchObject({ channelCount: 1, echoCancellation: true })
  })
})

describe('jauge du test', () => {
  it('silence = 0, voix = au milieu, saturation bornée à 1', () => {
    expect(levelOf([])).toBe(0)
    expect(levelOf(new Float32Array(512))).toBe(0)
    expect(levelOf(new Float32Array(512).fill(0.1))).toBeCloseTo(0.4, 5)
    expect(levelOf(new Float32Array(512).fill(1))).toBe(1)
  })
})
