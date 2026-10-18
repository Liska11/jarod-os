import { expect, test, type Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchShell, ROOT_PREFIX } from './launch'

// Settings › Secrets says how the vault is protected, as the core opened the database (A-08), in throwaway profiles only:
// 1. a fresh profile on this Windows account: the key goes to DPAPI, the screen says so;
// 2. a profile whose key was left in a key file (the fallback when DPAPI fails, reproduced by seeding `db.key` beside the database):
//    the screen warns and says what to do. No value is ever on the screen.
test.describe.configure({ mode: 'serial' })

/** Relative folder of the profile's database inside the root, learnt from the first run (where `jarod.db` was created). */
let profileDir = ''

const find = (dir: string, name: string): string | null => {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const found = find(full, name)
      if (found) return found
    }
  }
  return null
}

async function openSecrets(page: Page) {
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click()
    await page.waitForTimeout(800)
  }

  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Secrets', exact: true }).click()
}

test('a fresh profile: database key protected by DPAPI, said plainly', async () => {
  test.setTimeout(150_000)
  const shell = await launchShell()

  try {
    await openSecrets(shell.page)
    const note = shell.page.getByTestId('vault-protection')
    await expect(note).toHaveAttribute('data-state', 'dpapi', { timeout: 30_000 })
    await expect(note).toContainText('Coffre protégé')
    await expect(note).toContainText('DPAPI')

    const db = find(path.join(shell.root, 'data'), 'jarod.db')
    expect(db, 'jarod.db in the throwaway root').toBeTruthy()
    const dir = path.dirname(db as string)
    expect(existsSync(path.join(dir, 'db.key.dpapi'))).toBe(true)
    expect(existsSync(path.join(dir, 'db.key'))).toBe(false)
    profileDir = path.relative(shell.root, dir)
  } finally {
    await shell.close()
  }
})

test('a profile whose key is in a key file: a warning that says what it means and what to do', async () => {
  test.setTimeout(150_000)
  expect(profileDir, 'learnt from the first test').not.toBe('')
  const root = mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const dir = path.join(root, profileDir)
  mkdirSync(dir, { recursive: true })
  // No `db.key.dpapi`: the DPAPI store has nothing to give, the key-file store gives this one (what remains after DPAPI failed).
  const key = randomBytes(32).toString('hex')
  writeFileSync(path.join(dir, 'db.key'), key, 'utf8')
  const shell = await launchShell({}, { root, own: true })

  try {
    await openSecrets(shell.page)
    const note = shell.page.getByTestId('vault-protection')
    await expect(note).toHaveAttribute('data-state', 'weak', { timeout: 30_000 })
    await expect(note).toHaveAttribute('role', 'alert')
    await expect(note).toContainText('Protection faible')
    await expect(note).toContainText('db.key')
    await expect(note).toContainText('Pour revenir à DPAPI')
    // The core really opened the database with that file: it was not replaced by a DPAPI key.
    expect(existsSync(path.join(dir, 'jarod.db'))).toBe(true)
    expect(existsSync(path.join(dir, 'db.key.dpapi'))).toBe(false)
    // Nothing of the key reaches the page.
    expect(await shell.page.content()).not.toContain(key)
  } finally {
    await shell.close()
  }
})
