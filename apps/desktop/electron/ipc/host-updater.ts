import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { findBinary, flagOn, onTrial, runUpdater, shippedDir, TEST_KEY_ENV, type UpdaterReply, type UpdaterState, updaterRoot } from '../host-updater.ts'
import { log } from '../log.ts'

/*
 * Système › Mises à jour › Jarod-OS (A/B) — V-21, behind JAROD_HOST_UPDATER=1 (electron/host-updater.ts). With the flag off every channel
 * answers `enabled: false` and runs nothing. With it on: the state of the slots, installing a signed bundle the person picked (verified
 * first, then confirmed natively with the version it carries), and the two ends of a trial — "this version works" and "go back". There is
 * no launcher yet, so nothing restarts into the new slot: the slots are prepared and switched, and the trial is closed by the person.
 */

export interface HostUpdaterView {
  enabled: boolean
  binary: string | null
  root: string
  state: UpdaterState | null
  error: string | null
}

export type HostUpdaterAction = { ok: true; view: HostUpdaterView; message?: string } | { ok: false; error: string; view: HostUpdaterView }

/** The contracts the binary checks the manifest against: JAROD_OS_CONTRACTS_DIR, else a packaged copy, else the repository's (development). */
function contractsDir(): string | null {
  if (process.env.JAROD_OS_CONTRACTS_DIR) return process.env.JAROD_OS_CONTRACTS_DIR
  const shipped = shippedDir()
  const candidates = [...(shipped ? [path.join(shipped, 'contracts', 'v1')] : []), path.resolve(app.getAppPath(), '..', '..', 'contracts', 'v1')]

  return candidates.find(dir => fs.existsSync(path.join(dir, 'index.json'))) ?? null
}

const describe = (reply: Extract<UpdaterReply, { ok: false }>): string => `${reply.error} : ${reply.detail}`

/**
 * The health check of a trial: started by `jarod-launcher` with JAROD_UPDATER_TRIAL=1, this copy confirms itself the first time its core
 * reaches `ready`. Until then the launcher and the updater treat it as unproven: an exit with an error rolls it back, and so do a missed
 * deadline or too many starts.
 */
export function confirmTrialWhenReady(configDir: string, backend: { onState: (listener: (state: { phase: string }) => void) => unknown }): void {
  if (!onTrial(process.env)) return
  let done = false

  backend.onState(state => {
    if (done || state.phase !== 'ready') return
    done = true
    const binary = findBinary(process.env)
    if (!binary) return log('host-updater', 'trial: jarod-updater not found, cannot confirm')

    void runUpdater(binary, 'confirm', { root: updaterRoot(process.env, configDir), contracts: contractsDir() }).then(reply =>
      log('host-updater', reply.ok ? `trial confirmed healthy (${process.env.JAROD_UPDATER_VERSION ?? '?'})` : `trial confirm refused: ${reply.error}: ${reply.detail}`)
    )
  })
}

export function registerHostUpdaterIpc(configDir: string): void {
  const root = updaterRoot(process.env, configDir)
  let busy = false

  const options = () => ({ root, contracts: contractsDir(), testKey: app.isPackaged ? null : (process.env[TEST_KEY_ENV] ?? null) })

  const view = async (): Promise<HostUpdaterView> => {
    if (!flagOn(process.env)) return { enabled: false, binary: null, root, state: null, error: null }
    const binary = findBinary(process.env)
    if (!binary) return { enabled: true, binary: null, root, state: null, error: 'jarod-updater introuvable (JAROD_UPDATER_BIN ou PATH).' }

    const reply = await runUpdater(binary, 'status', options())

    return reply.ok ? { enabled: true, binary, root, state: reply.state ?? null, error: null } : { enabled: true, binary, root, state: null, error: describe(reply) }
  }

  /** Runs one changing step: flag, binary and a real window required; one at a time. */
  const act = async (event: Electron.IpcMainInvokeEvent, step: (binary: string, win: BrowserWindow) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>): Promise<HostUpdaterAction> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const before = await view()

    if (!win) return { ok: false, error: 'Cette fenêtre ne peut pas mettre Jarod-OS à jour.', view: before }
    if (!before.enabled || !before.binary) return { ok: false, error: before.error ?? 'La mise à jour A/B est désactivée (JAROD_HOST_UPDATER).', view: before }
    if (busy) return { ok: false, error: 'Une opération de mise à jour est déjà en cours.', view: before }

    busy = true
    try {
      const result = await step(before.binary, win)
      const after = await view()

      return result.ok ? { ok: true, view: after, message: result.message } : { ok: false, error: result.error, view: after }
    } finally {
      busy = false
    }
  }

  const confirm = async (win: BrowserWindow, message: string, detail: string, action: string): Promise<boolean> => {
    const { response } = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons: [action, 'Annuler'], defaultId: 1, cancelId: 1, noLink: true })

    return response === 0
  }

  ipcMain.handle(IPC.hostUpdaterState, () => view())

  // Install: the person picks the bundle's folder; it is verified (signature, hashes, version) BEFORE the question, which names the version.
  ipcMain.handle(IPC.hostUpdaterInstall, (event): Promise<HostUpdaterAction> =>
    act(event, async (binary, win) => {
      const picked = await dialog.showOpenDialog(win, { title: 'Dossier de la mise à jour signée', properties: ['openDirectory'] })
      const bundle = picked.canceled ? null : picked.filePaths[0]
      if (!bundle) return { ok: false, error: 'Aucun dossier choisi.' }

      const checked = await runUpdater(binary, 'verify', { ...options(), bundle })
      if (!checked.ok) return { ok: false, error: `Mise à jour refusée — ${describe(checked)}` }

      const yes = await confirm(
        win,
        `Installer Jarod-OS ${checked.version} dans l’emplacement de secours ?`,
        `Signature et ${checked.files} fichier(s) vérifiés. La version en service n’est pas touchée ; la nouvelle passe à l’essai et pourra être annulée.`,
        'Installer'
      )
      if (!yes) return { ok: false, error: 'Installation annulée.' }

      const done = await runUpdater(binary, 'install', { ...options(), bundle })
      log('host-updater', done.ok ? `installed ${done.installed?.version} in slot ${done.installed?.slot}` : `install refused: ${done.error}`)

      return done.ok ? { ok: true, message: `Jarod-OS ${done.installed?.version} installé, à l’essai.` } : { ok: false, error: describe(done) }
    })
  )

  ipcMain.handle(IPC.hostUpdaterConfirm, (event): Promise<HostUpdaterAction> =>
    act(event, async binary => {
      const done = await runUpdater(binary, 'confirm', options())
      log('host-updater', done.ok ? 'trial confirmed healthy' : `confirm refused: ${done.error}`)

      return done.ok ? { ok: true, message: 'Version validée.' } : { ok: false, error: describe(done) }
    })
  )

  ipcMain.handle(IPC.hostUpdaterRollback, (event): Promise<HostUpdaterAction> =>
    act(event, async (binary, win) => {
      const yes = await confirm(win, 'Revenir à la version précédente ?', 'La version à l’essai sera bloquée sur cette machine et ne sera pas réinstallée.', 'Revenir')
      if (!yes) return { ok: false, error: 'Retour annulé.' }

      const done = await runUpdater(binary, 'rollback', { ...options(), reason: 'retour demandé depuis Système › Mises à jour' })
      log('host-updater', done.ok ? `rolled back to ${done.restored}` : `rollback refused: ${done.error}`)

      return done.ok ? { ok: true, message: `Retour à Jarod-OS ${done.restored}.` } : { ok: false, error: describe(done) }
    })
  )
}
