import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchShell, ROOT_PREFIX, removeRoot } from './launch'

/*
 * V-22 — the real-session bench of the Rust adjudicator in shadow (`jarod-control-shadow`, a debug build of host-rust/crates/host-control).
 *
 *   npm run bundle:core && npm run build && npx playwright test e2e/control-shadow-session.spec.ts
 *
 * A real session, not a matrix: the BUILT app with its real bundled core, in a throwaway profile, flag on. Nothing is sent to the door by
 * the test: every request the shadow sees is one the app's own processes sent, the core first (its capability probes ask the backend door
 * `state` and `ui-list`). The session: the first-run screens, the core ready, the capability registry read and re-checked, Réglages ›
 * Capacités opened, a few pages visited, the app quit normally. Then the counter (`control-shadow-stats.json`, last written at quit) and the
 * divergence file are read. Passes when requests really went through the shadow, none diverged, and the shadow stopped with the app.
 * Agent turns (the `ui`/`run` an agent's tools send) need a model and are not part of it. Skipped when the binary was not built.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BIN = process.env.JAROD_CONTROL_SHADOW_BIN ?? path.join(REPO, 'host-rust', 'target', 'debug', 'jarod-control-shadow.exe')
const CONTRACTS = path.join(REPO, 'contracts', 'v1')

test.skip(!existsSync(BIN), 'jarod-control-shadow is not built')
test.setTimeout(240_000)

async function invoke<T>(wsUrl: string, wsToken: string, channel: string, ...args: unknown[]): Promise<T> {
  const ws = new WebSocket(`${wsUrl}?token=${wsToken}`)

  try {
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok())
      ws.addEventListener('error', () => bad(new Error('control line refused')))
    })

    return await new Promise<T>((ok, bad) => {
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: { result: T }; error?: { message?: string } }

        if (frame.id === 1) frame.error ? bad(new Error(frame.error.message ?? 'error')) : ok(frame.result!.result)
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'jarod.invoke', params: { channel, args } }))
    })
  } finally {
    ws.close()
  }
}

test('a real session goes through the shadow: requests compared, none diverged, the counts kept at quit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const shell = await launchShell({ JAROD_HOST_CONTROL: '1', JAROD_CONTROL_SHADOW_BIN: BIN, JAROD_OS_CONTRACTS_DIR: CONTRACTS }, { root, own: false })
  const { page } = shell
  const config = path.join(root, 'config')

  try {
    await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

    for (let step = 0; step < 8; step++) {
      const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

      if (!(await next.count())) break
      await next.first().click()
      await page.waitForTimeout(800)
    }

    await expect.poll(async () => (await page.evaluate(() => window.jarodOS.backend.getState())).phase, { timeout: 90_000 }).toBe('ready')
    const { wsUrl, wsToken } = await page.evaluate(() => window.jarodOS.backend.getState())

    // The core probes the shell's door for its registry, as Réglages and its `capabilities` tool do (the list is cached by the core)…
    const rows = await invoke<{ id: string; state: string }[]>(wsUrl as string, wsToken as string, 'capabilities-list')
    expect(rows.find(row => row.id === 'shell.state')?.state).toBe('available')
    const windowId = rows.find(row => row.id.startsWith('ui.'))?.id
    expect(windowId).toBeTruthy()

    // …and probes again, without its cache, each time a capability is re-checked (Réglages › Capacités, « Revérifier »).
    for (let round = 0; round < 5; round++) {
      expect(await invoke<{ state: string }>(wsUrl as string, wsToken as string, 'capabilities-check', 'shell.state')).toMatchObject({ state: 'available' })
      expect(await invoke<{ state: string }>(wsUrl as string, wsToken as string, 'capabilities-check', windowId)).toMatchObject({ state: 'available' })
    }

    await page.getByRole('button', { name: 'Réglages' }).first().click()
    await page.getByRole('button', { name: 'Capacités', exact: true }).first().click()
    await expect(page.getByTestId('capabilities-shell')).toHaveAttribute('data-state', 'available', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Accueil' }).first().click()
    await page.waitForTimeout(3_000)
  } finally {
    await shell.app.close().catch(() => undefined)
  }

  try {
    const statsFile = path.join(config, 'control-shadow-stats.json')
    const divergenceFile = path.join(config, 'control-shadow.jsonl')
    const stats = JSON.parse(readFileSync(statsFile, 'utf8')) as {
      compared: number
      diverged: number
      known: number
      dropped: number
      stopReason: string | null
      byCommand: Record<string, { compared: number; diverged: number; known: number }>
    }
    const divergences = existsSync(divergenceFile) ? readFileSync(divergenceFile, 'utf8').trim().split('\n').filter(Boolean) : []
    const report = { ...stats, divergences }

    console.log(`control-shadow, real session: ${JSON.stringify(report, null, 1)}`)
    await test.info().attach('control-shadow-session.json', { body: JSON.stringify(report, null, 1), contentType: 'application/json' })

    expect(divergences).toEqual([])
    expect(stats).toMatchObject({ diverged: 0, dropped: 0, stopReason: 'app quit' })
    expect(stats.compared).toBeGreaterThan(0)
    expect(stats.byCommand['backend:state']?.compared ?? 0).toBeGreaterThan(0)
    expect(stats.byCommand['backend:ui-list']?.compared ?? 0).toBeGreaterThan(0)
  } finally {
    await removeRoot(root)
  }
})
