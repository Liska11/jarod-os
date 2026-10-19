import { describe, expect, it } from 'vitest'
import { adoptLegacyEnv, NEVER_ADOPTED } from './legacy-env.ts'

describe('adoptLegacyEnv : HERALD_OS_* reste lu, JAROD_OS_* l’emporte', () => {
  it('l’ancien nom seul : le nouveau prend sa valeur, l’ancien reste en place', () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_BACKEND: 'hermes', PATH: 'x' }

    expect(adoptLegacyEnv(env)).toEqual(['JAROD_OS_BACKEND'])
    expect(env.JAROD_OS_BACKEND).toBe('hermes')
    expect(env.HERALD_OS_BACKEND).toBe('hermes')
  })

  it('les deux noms : le nouveau l’emporte, rien n’est écrasé', () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_BACKEND: 'hermes', JAROD_OS_BACKEND: 'jarod' }

    expect(adoptLegacyEnv(env)).toEqual([])
    expect(env.JAROD_OS_BACKEND).toBe('jarod')
  })

  it('un nouveau nom vide compte comme posé : une valeur vide choisie n’est pas remplacée', () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_SCALE: '2', JAROD_OS_SCALE: '' }

    expect(adoptLegacyEnv(env)).toEqual([])
    expect(env.JAROD_OS_SCALE).toBe('')
  })

  it('HERALD_OS_DEV_UNSIGNED, nom figé par le contrat c8, n’a jamais de second nom', () => {
    const env: NodeJS.ProcessEnv = { HERALD_OS_DEV_UNSIGNED: '1' }

    expect(NEVER_ADOPTED.has('HERALD_OS_DEV_UNSIGNED')).toBe(true)
    expect(adoptLegacyEnv(env)).toEqual([])
    expect(env.JAROD_OS_DEV_UNSIGNED).toBeUndefined()
  })

  it('ne rend que des noms, jamais une valeur (un jeton ne sort pas de l’environnement)', () => {
    const secretValue = 'ctl-0123456789abcdef'
    const env: NodeJS.ProcessEnv = { HERALD_OS_CONTROL_TOKEN: secretValue, HERALD_OS_SCALE: '2' }
    const out = adoptLegacyEnv(env)

    expect(out).toEqual(['JAROD_OS_CONTROL_TOKEN', 'JAROD_OS_SCALE'])
    expect(JSON.stringify(out)).not.toContain(secretValue)
  })

  it('les noms voisins ne sont pas touchés', () => {
    const env: NodeJS.ProcessEnv = { HERALD_SANDBOX_BIN: 'a', HERMES_OS_BACKEND: 'b', JAROD_GATEWAY_TOKEN: 'c' }

    expect(adoptLegacyEnv(env)).toEqual([])
    expect(Object.keys(env).sort()).toEqual(['HERALD_SANDBOX_BIN', 'HERMES_OS_BACKEND', 'JAROD_GATEWAY_TOKEN'])
  })
})
