import { expect, test } from '@playwright/test'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

// BL-01 (audit du 2026-10-19) dans l'application réelle, profil jetable : AUCUN canal IPC n'échappe au contrôle d'émetteur. Tous les
// gestionnaires (`handle`) et écouteurs (`on`) qu'Electron connaît une fois le shell démarré sont passés par le garde, et aucun n'était
// enregistré avant lui.
let shell: Launched

test.afterAll(async () => {
  await shell?.close()
})

test('chaque canal IPC passe par le contrôle d’émetteur ; aucun n’a été enregistré avant lui', async () => {
  shell = await launchShell()
  await expect(shell.page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  const seen = await shell.app.evaluate(({ ipcMain }) => {
    const internal = ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> }
    const report = (globalThis as { __jarodIpcGuard?: () => { before: string[]; guarded: string[]; electron: string[] } | null }).__jarodIpcGuard?.() ?? null

    return {
      handlers: [...(internal._invokeHandlers?.keys() ?? [])],
      listeners: ipcMain.eventNames().filter((name): name is string => typeof name === 'string'),
      report
    }
  })

  expect(seen.report, 'le garde est posé et rend sa liste').not.toBeNull()
  console.info(`[BL-01] enregistrés avant le garde : ${seen.report!.before.join(', ') || 'aucun'}`)
  expect(seen.report!.before).toEqual([])
  // Ce qu'Electron pose lui-même (et l'événement `error`) : nommé, connu, jamais un canal de Jarod.
  expect(seen.report!.electron.every(c => c === 'error' || c === 'IMPORT_SHARED_TEXTURE_RELEASE_RENDERER_TO_MAIN')).toBe(true)
  const guarded = new Set([...seen.report!.guarded, ...seen.report!.electron])
  const all = [...new Set([...seen.handlers, ...seen.listeners])]
  const escaped = all.filter(channel => !guarded.has(channel))

  console.info(`[BL-01] ${seen.handlers.length} gestionnaires et ${seen.listeners.length} écouteurs dans l'application ; ${guarded.size} canaux passés par le garde ; hors garde : ${escaped.join(', ') || 'aucun'}`)
  expect(seen.handlers.length).toBeGreaterThan(150)
  expect(escaped).toEqual([])

  // Domaines (second segment de `jarod-os:<domaine>:<canal>`) : tous passent par le même garde.
  const domains = new Map<string, number>()

  for (const channel of guarded) {
    const domain = channel.startsWith('jarod-os:') ? channel.split(':')[1]! : `(hors préfixe) ${channel}`
    domains.set(domain, (domains.get(domain) ?? 0) + 1)
  }
  console.info(`[BL-01] domaines gardés : ${[...domains].sort(([a], [b]) => a.localeCompare(b)).map(([d, n]) => `${d}=${n}`).join(' ')}`)
})

// Refus RÉEL d'un émetteur non autorisé : une fenêtre qui porte le preload du shell (donc `window.jarodOS`) mais une autre page. Contrôle
// positif dans la même exécution : la fenêtre du shell, elle, est servie sur les mêmes canaux (aucune capacité retirée à Jarod).
test('une page étrangère munie du preload du shell est refusée ; la fenêtre du shell reste servie', async () => {
  const channels = ['externalBackup.state', 'externalBackup.restic.list', 'externalBackup.restic.check', 'system.info'] as const
  const call = `(async () => {
    const api = window.jarodOS
    if (!api) return { bridge: false }
    const out = {}
    const fns = { 'externalBackup.state': () => api.externalBackup.state(), 'externalBackup.restic.list': () => api.externalBackup.restic.list(), 'externalBackup.restic.check': () => api.externalBackup.restic.check(), 'system.info': () => api.system.info() }
    for (const [name, fn] of Object.entries(fns)) {
      try { await fn(); out[name] = 'served' } catch (e) { out[name] = /may not use the shell/.test(String(e && e.message)) ? 'refused' : 'error: ' + String(e && e.message) }
    }
    return { bridge: true, out }
  })()`

  type Outcome = { bridge: boolean; out?: Record<string, string> }
  const shellSide = (await shell.page.evaluate(call)) as Outcome

  expect(shellSide.bridge).toBe(true)

  for (const name of channels) {
    // Servi, ou refusé PAR LE GESTIONNAIRE (pas de restic configuré dans ce profil) — jamais par le garde.
    expect(shellSide.out![name], `${name} depuis le shell`).not.toBe('refused')
  }

  // Le MÊME preload que la fenêtre du shell (window.ts : dist/electron/preload.cjs).
  const preloadFile = path.resolve(import.meta.dirname, '..', 'dist', 'electron', 'preload.cjs')
  const foreign = (await shell.app.evaluate(async ({ BrowserWindow }, { script, preload }) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })

    try {
      await win.loadURL('data:text/html,<p>page étrangère</p>')

      return { result: await win.webContents.executeJavaScript(script) }
    } finally {
      win.destroy()
    }
  }, { script: call, preload: preloadFile })) as { result: Outcome }

  console.info(`[BL-01] shell : ${JSON.stringify(shellSide.out)} ; page étrangère : ${JSON.stringify(foreign.result.out)}`)
  // Sans le pont, le test ne prouverait rien : la page étrangère DOIT avoir `window.jarodOS`.
  expect(foreign.result.bridge, 'la page étrangère porte bien le pont du shell').toBe(true)

  for (const name of channels) {
    expect(foreign.result.out![name], `${name} depuis une page étrangère`).toBe('refused')
  }
})
