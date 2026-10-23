import { ipcMain } from 'electron'
import type { EngineEvent, EngineInfo, EngineResult, EnginesPrefs } from '../../shared/engines.ts'
import { parseEnginesPrefs } from '../../shared/engines.ts'
import { IPC } from '../../shared/ipc.ts'
import type { BackendManager } from '../backend/manager.ts'
import { type CoreLocation, jarodWorkspace, resolveJarodCore } from '../backend/jarod-core.ts'
import { resolveBackendRuntime } from '../backend/resolve.ts'
import { DshEngine, resolveDsh } from '../engines/dsh.ts'
import { dshHome, listEngines, readEnginesPrefs, writeEnginesPrefs } from '../engines/registry.ts'
import { log } from '../log.ts'
import { internetAllowed } from '../network.ts'

/*
 * Moteurs (docs/MULTI-RUNTIME-FAISABILITE.md) : la liste et l'état de chacun, le choix du moteur du cockpit (appliqué au prochain
 * lancement, jamais en cours de session), et DSH conduit à côté en ACP (démarrer, sessions, tour, annulation, accords, arrêt).
 */

export { applyBackendChoice } from '../engines/registry.ts'

export interface EnginesIpcDeps {
  backend: BackendManager
  coreLocation: Pick<CoreLocation, 'packaged' | 'resourcesPath' | 'appPath'>
  configDir: string
  broadcast: (channel: string, payload: unknown) => void
  relaunch: () => void
}

export function registerEnginesIpc(deps: EnginesIpcDeps): {
  stop: () => Promise<void>
} {
  let prefs = readEnginesPrefs(deps.configDir)
  const pushState = () => deps.broadcast(IPC.enginesChanged, null)
  const dsh = new DshEngine({
    resolve: () => resolveDsh(),
    home: dshHome(),
    workspace: jarodWorkspace(),
    policy: () => prefs.dshPermission,
    internet: internetAllowed,
    emit: (event: EngineEvent) => deps.broadcast(IPC.enginesEvent, event),
    onState: pushState,
    log: line => log('engines', line),
    // Installé : Jarod-OS lui-même en mode Node (Electron 44 embarque Node 24, que DSH accepte).
    execPath: deps.coreLocation.packaged ? process.execPath : undefined
  })

  const list = (): EngineInfo[] =>
    listEngines({
      backend: deps.backend.getState(),
      core: resolveJarodCore({ ...deps.coreLocation, env: process.env }),
      hermes: resolveBackendRuntime(),
      dsh: resolveDsh(),
      dshState: dsh.getState()
    })

  ipcMain.handle(IPC.enginesList, (): { engines: EngineInfo[]; prefs: EnginesPrefs; dshHome: string } => ({
    engines: list(),
    prefs,
    dshHome: dshHome()
  }))

  ipcMain.handle(IPC.enginesSetPrefs, (_event, next: unknown): EnginesPrefs => {
    prefs = parseEnginesPrefs(next)
    writeEnginesPrefs(deps.configDir, prefs)
    log('engines', `prefs: backend=${prefs.backend} dshPermission=${prefs.dshPermission}`)
    pushState()

    return prefs
  })

  // Changer le moteur du cockpit : un redémarrage de Jarod-OS que la personne demande, jamais en arrière-plan.
  ipcMain.handle(IPC.enginesRelaunch, () => {
    log('engines', `relaunch requested to apply backend=${prefs.backend}`)
    deps.relaunch()
  })

  const text = (value: unknown, max = 100_000): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null)

  ipcMain.handle(IPC.enginesDshStart, (): Promise<EngineResult> => dsh.start())
  ipcMain.handle(IPC.enginesDshStop, async (): Promise<EngineResult> => {
    await dsh.stop()

    return { ok: true, value: undefined }
  })
  ipcMain.handle(IPC.enginesDshNewSession, (): Promise<EngineResult<string>> => dsh.newSession())
  ipcMain.handle(IPC.enginesDshSessions, () => dsh.listSessions())
  ipcMain.handle(IPC.enginesDshResume, (_event, sessionId: unknown): Promise<EngineResult> | EngineResult => {
    const id = text(sessionId, 200)

    return id ? dsh.resumeSession(id) : { ok: false, error: 'bad-session' }
  })
  ipcMain.handle(IPC.enginesDshPrompt, (_event, sessionId: unknown, prompt: unknown): EngineResult => {
    const id = text(sessionId, 200)
    const body = text(prompt)

    return id && body ? dsh.prompt(id, body) : { ok: false, error: 'bad-request' }
  })
  ipcMain.handle(IPC.enginesDshCancel, (_event, sessionId: unknown): EngineResult => {
    const id = text(sessionId, 200)

    return id ? dsh.cancel(id) : { ok: false, error: 'bad-session' }
  })
  ipcMain.handle(IPC.enginesDshApprove, (_event, requestId: unknown, decision: unknown, optionId: unknown): EngineResult => {
    const id = text(requestId, 100)

    if (!id || (decision !== 'allow' && decision !== 'deny')) {
      return { ok: false, error: 'bad-request' }
    }

    return dsh.respondApproval(id, decision, text(optionId, 100) ?? undefined)
  })

  return { stop: () => dsh.stop() }
}
