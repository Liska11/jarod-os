import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

/*
 * V-06 — the plugin platform on the BUILT app (real shell, real bundled core, real isolated plugin processes, throwaway profile):
 *  - the example plugin Jarod lays down on the very first run is approved and runs ;
 *  - a plugin folder dropped while the app runs shows up on the screen BLOCKED (« Non approuvé »), its code never started ;
 *  - « Approuver et lancer » goes through the engine's NATIVE confirmation (version, surfaces, fingerprint, local signature), then it runs ;
 *  - changed afterwards without a new version: blocked again (« Modifié depuis l'approbation »).
 * The native box is answered by a stub that records it. Run `npm run bundle:core && npm run build` first; labels from src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page
let pluginsDir = ''

const dialogs = () => shell.app.evaluate(() => (globalThis as unknown as { __dialogs: { message: string; detail: string }[] }).__dialogs)
const row = (id: string) => page.getByTestId(`plugin-${id}`)

/** The profile's plugins folder: where Jarod laid its example plugin on the first run (found, never assumed). */
function findPluginsDir(root: string): string {
  const stack = [root]

  while (stack.length) {
    const dir = stack.pop()!

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)

      if (entry.name === 'plugins' && fs.existsSync(path.join(full, 'des', 'plugin.json'))) return full
      if (entry.name !== 'node_modules') stack.push(full)
    }
  }

  throw new Error('plugins folder not found')
}

function drop(version: string, marker: string): void {
  const root = path.join(pluginsDir, 'echo-v06')

  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ id: 'echo-v06', name: 'Écho V-06', version, main: 'index.js', permissions: ['tools'] }))
  fs.writeFileSync(path.join(root, 'index.js'), `exports.activate = (api) => { api.registerTool({ name: "echo", description: "${marker}", parameters: { type: "object", properties: {} }, run: () => "${marker}" }); };\n`)
}

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) {
      break
    }

    await next.first().click()
    await page.waitForTimeout(800)
  }

  await shell.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dialogs: { message: string; detail: string }[] }

    g.__dialogs = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string }

      g.__dialogs.push({ message: options.message, detail: options.detail ?? '' })

      return { response: 0, checkboxChecked: false }
    }) as never
  })
  pluginsDir = findPluginsDir(shell.root)
})

test.afterAll(async () => {
  await shell?.close()
})

async function openPlugins(): Promise<void> {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: /^Règles d.automatisation/ }).first().click()
  await expect(page.getByText('Plugins de l’utilisateur')).toBeVisible({ timeout: 30_000 })
}

test('the example plugin laid on the first run is approved and runs', async () => {
  await openPlugins()
  await expect(row('des')).toHaveAttribute('data-state', 'active', { timeout: 30_000 })
  await expect(row('des')).toHaveAttribute('data-approval', 'approved')
  await expect(row('des')).toContainText('Approuvé par vous')
})

test('a dropped plugin shows up blocked, then runs once approved through the native box', async () => {
  drop('1.0.0', 'premier')
  // Leaving and coming back re-reads the list: the new folder appears, blocked.
  await page.getByRole('button', { name: 'Général', exact: true }).first().click()
  await openPlugins()
  await expect(row('echo-v06')).toHaveAttribute('data-state', 'blocked', { timeout: 30_000 })
  await expect(row('echo-v06')).toHaveAttribute('data-approval', 'unapproved')
  await expect(row('echo-v06')).toContainText('Non approuvé')

  await page.getByRole('button', { name: 'Approuver et lancer' }).click()
  await expect(row('echo-v06')).toHaveAttribute('data-state', 'active', { timeout: 30_000 })
  const box = (await dialogs()).at(-1)!

  expect(box.message).toMatch(/Approuver et lancer le plugin « Écho V-06 »/)
  expect(box.detail).toMatch(/Surfaces demandées : tools/)
  expect(box.detail).toMatch(/signé par la clé de votre profil/)
  await page.locator('section', { has: page.getByRole('heading', { name: 'Plugins de l’utilisateur' }) }).screenshot({ path: test.info().outputPath('plugins.png') }).catch(() => undefined)
})

test('changed afterwards without a new version: stopped and blocked at once, « Modifié depuis l’approbation »', async () => {
  drop('1.0.0', 'pirate')
  // Leaving and coming back re-reads the list: the engine sees the new fingerprint, stops the plugin and blocks it.
  await page.getByRole('button', { name: 'Général', exact: true }).first().click()
  await openPlugins()
  await expect(row('echo-v06')).toHaveAttribute('data-state', 'blocked', { timeout: 30_000 })
  await expect(row('echo-v06')).toHaveAttribute('data-approval', 'modified')
  await expect(page.getByRole('button', { name: 'Approuver la mise à jour' })).toBeVisible()
})
