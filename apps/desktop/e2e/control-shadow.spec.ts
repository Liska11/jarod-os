import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchShell } from './launch'

// V-22 — the Rust adjudicator in shadow of the shell's control doors, in the running app, driving the REAL `jarod-control-shadow` (a debug
// build of host-rust/crates/host-control). Flag on: the shadow starts beside the doors and stays up while the app and its core come up;
// flag off: nothing starts. Skipped when the binary was not built (`cargo build -p host-control`).
test.describe.configure({ mode: 'serial' })

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BIN = process.env.JAROD_CONTROL_SHADOW_BIN ?? path.join(REPO, 'host-rust', 'target', 'debug', 'jarod-control-shadow.exe')
const CONTRACTS = path.join(REPO, 'contracts', 'v1')

test.skip(!existsSync(BIN), 'jarod-control-shadow is not built')

const shadowLines = (lines: string[]) => lines.filter(line => line.includes('[control-shadow]'))

test('the flag on: the shadow starts with the real contracts and stays up; no divergence is written', async () => {
  const shell = await launchShell({ JAROD_HOST_CONTROL: '1', JAROD_CONTROL_SHADOW_BIN: BIN, JAROD_OS_CONTRACTS_DIR: CONTRACTS })

  try {
    await expect(shell.page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
    // Long enough for the core to come up and dial the door, and for a shadow that would die at start to have said so.
    await shell.page.waitForTimeout(5_000)

    const lines = shadowLines(await shell.page.evaluate(() => window.jarodOS.backend.logTail(2000)))

    expect(lines.some(line => line.includes('[control-shadow] on:'))).toBe(true)
    expect(lines.filter(line => line.includes('[control-shadow] off'))).toEqual([])
    expect(existsSync(path.join(shell.root, 'config', 'control-shadow.jsonl'))).toBe(false)
  } finally {
    await shell.close()
  }
})

test('the flag off: nothing starts, even with the binary at hand', async () => {
  const shell = await launchShell({ JAROD_CONTROL_SHADOW_BIN: BIN, JAROD_OS_CONTRACTS_DIR: CONTRACTS })

  try {
    await expect(shell.page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

    expect(shadowLines(await shell.page.evaluate(() => window.jarodOS.backend.logTail(2000)))).toEqual([])
  } finally {
    await shell.close()
  }
})
