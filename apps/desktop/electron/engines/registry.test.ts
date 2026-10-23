import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEnginesPrefs } from '../../shared/engines.ts'
import type { BackendState } from '../../shared/ipc.ts'
import { applyBackendChoice, hermesReleaseDate, jarodHermesHome, listEngines } from './registry.ts'

const idle: BackendState = { phase: 'idle', attempt: 0, logTail: [] }
const core = { dir: 'C:/app/jarod-core', gateway: 'gateway.mjs', node: 'node' }
const hermesRuntime = {
  kind: 'managed' as const,
  label: 'managed Hermes install',
  root: 'C:/hermes/hermes-agent',
  command: ['python.exe']
}
const dshInstall = {
  bin: 'C:/dsh/lib/bin.js',
  source: 'path' as const,
  version: '0.2.1-rc.2'
}

describe('parseEnginesPrefs', () => {
  it('garde les valeurs connues et retombe sur « auto » / « ask » pour le reste', () => {
    expect(parseEnginesPrefs({ backend: 'hermes', dshPermission: 'deny' })).toEqual({ version: 1, backend: 'hermes', dshPermission: 'deny' })
    expect(parseEnginesPrefs({ backend: 'dsh', dshPermission: 'always' })).toEqual({ version: 1, backend: 'auto', dshPermission: 'ask' })
    expect(parseEnginesPrefs(null)).toEqual({
      version: 1,
      backend: 'auto',
      dshPermission: 'ask'
    })
  })
})

describe('applyBackendChoice', () => {
  const file = (prefs: object) => () => JSON.stringify(prefs)

  it('« auto » ne touche à rien', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyBackendChoice('cfg', env, file({ backend: 'auto' }))).toBeNull()
    expect(env).toEqual({})
  })

  it('Hermes choisi dans les réglages reçoit un dossier de Jarod, jamais celui de Hermes Desktop', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyBackendChoice('cfg', env, file({ backend: 'hermes' }))).toContain('hermes')
    expect(env).toEqual({
      JAROD_OS_BACKEND: 'hermes',
      HERMES_HOME: jarodHermesHome()
    })
    expect(jarodHermesHome()).toContain(path.join('engines', 'hermes-home'))
  })

  it('l’environnement garde la main : JAROD_OS_BACKEND, JAROD_OS_BACKEND_URL, HERMES_HOME', () => {
    const forced: NodeJS.ProcessEnv = { JAROD_OS_BACKEND: 'jarod' }
    expect(applyBackendChoice('cfg', forced, file({ backend: 'hermes' }))).toBeNull()
    expect(forced).toEqual({ JAROD_OS_BACKEND: 'jarod' })
    const home: NodeJS.ProcessEnv = { HERMES_HOME: 'D:/my-hermes' }
    applyBackendChoice('cfg', home, file({ backend: 'hermes' }))
    expect(home).toEqual({
      HERMES_HOME: 'D:/my-hermes',
      JAROD_OS_BACKEND: 'hermes'
    })
  })

  it('un fichier absent ou illisible vaut « auto »', () => {
    expect(
      applyBackendChoice('cfg', {}, () => {
        throw new Error('ENOENT')
      })
    ).toBeNull()
  })
})

describe('listEngines', () => {
  const facts = (overrides: Partial<Parameters<typeof listEngines>[0]> = {}) =>
    listEngines({
      backend: idle,
      core,
      hermes: hermesRuntime,
      dsh: dshInstall,
      dshState: { state: 'stopped' },
      ...overrides
    })

  it('installé n’est pas connecté : tout est « détecté » tant que rien ne tourne', () => {
    expect(facts().map(e => [e.id, e.state, e.active])).toEqual([
      ['jarod', 'detected', false],
      ['hermes', 'detected', false],
      ['dsh', 'detected', false]
    ])
  })

  it('le moteur du cockpit suit le gestionnaire ; « prêt » seul vaut connecté', () => {
    const ready = facts({
      backend: {
        ...idle,
        phase: 'ready',
        runtime: { kind: 'jarod', label: 'core', command: [] }
      }
    })
    expect(ready.find(e => e.id === 'jarod')).toMatchObject({
      state: 'connected',
      active: true
    })
    expect(ready.find(e => e.id === 'hermes')).toMatchObject({
      state: 'detected',
      active: false
    })
    const starting = facts({
      backend: { ...idle, phase: 'starting', runtime: hermesRuntime }
    })
    expect(starting.find(e => e.id === 'hermes')).toMatchObject({
      state: 'starting',
      active: true
    })
    const failed = facts({
      backend: {
        ...idle,
        phase: 'failed',
        runtime: hermesRuntime,
        error: 'boom'
      }
    })
    expect(failed.find(e => e.id === 'hermes')).toMatchObject({
      state: 'failed',
      error: 'boom'
    })
  })

  it('DSH : l’état de sa connexion ACP, et « absent » sans installation', () => {
    expect(facts({ dshState: { state: 'connected' } }).find(e => e.id === 'dsh')?.state).toBe('connected')
    expect(facts({ dshState: { state: 'failed', error: 'auth-required' } }).find(e => e.id === 'dsh')).toMatchObject({ state: 'failed', error: 'auth-required' })
    expect(facts({ dsh: null }).find(e => e.id === 'dsh')).toMatchObject({
      installed: false,
      state: 'absent'
    })
  })

  it('capacités vérifiées : DSH répond par message entier, sans mémoire ni Studio', () => {
    expect(facts().find(e => e.id === 'dsh')?.capabilities).toMatchObject({
      streaming: 'partial',
      memory: 'absent',
      studio: 'absent',
      approvals: 'available',
      cancel: 'available'
    })
  })
})

describe('hermesReleaseDate', () => {
  it('lit la date de publication sans lancer Hermes', () => {
    expect(hermesReleaseDate('C:/h', () => '__release_date__ = "2026.9.24"\n')).toBe('2026.9.24')
    expect(
      hermesReleaseDate('C:/h', () => {
        throw new Error('ENOENT')
      })
    ).toBeUndefined()
  })
})
