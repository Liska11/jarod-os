import { expect, type Page, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

// Règles d'autorisation depuis Réglages › Agent et sécurité (2026-10-21), profil jetable : ajout avec aperçu, confirmation NATIVE pour ce qui
// donne plus de pouvoir, modification en place, ordre, révocation — par le MÊME service que `jarod permissions`, dont la lecture (`list --json`)
// voit exactement ce que l'écran a écrit. Les boîtes natives sont remplacées dans le main et enregistrées ; rien ne sort de la machine.
let shell: Launched
let page: Page

test.afterAll(async () => {
  await shell?.close()
})

type Rule = { id: string; tool: string; decision: string; autonomous?: boolean; target?: string; uses?: number; expiresAt?: number; by?: string }

/** Le profil du cœur (JAROD_HOME) dans la racine jetable. */
function profileOf(root: string): string {
  const stack = [path.join(root, 'data')]

  while (stack.length) {
    const dir = stack.pop()!

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name)

        if (entry.name === 'profile') {
          return full
        }

        stack.push(full)
      }
    }
  }

  throw new Error(`aucun profil sous ${root}`)
}

/** Ce que lit `jarod permissions list --json` sur ce profil (lecture : ni terminal ni code). */
function cliRules(root: string): Rule[] {
  const bin = path.resolve(import.meta.dirname, '..', '..', '..', 'jarod-core', 'packages', 'cli', 'bin', 'jarod.mjs')
  const out = execFileSync(process.execPath, [bin, 'permissions', 'list', '--json'], { encoding: 'utf8', env: { ...process.env, JAROD_HOME: profileOf(root), ELECTRON_RUN_AS_NODE: '' }, timeout: 120_000, windowsHide: true })

  return JSON.parse(out.slice(out.indexOf('[')))
}

test('Réglages : créer, modifier, déplacer, révoquer une règle — le même service et la même liste que la commande', async () => {
  shell = await launchShell()
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await page.evaluate(() => window.jarodOS.backend.getState()).catch(() => ({ phase: 'navigating' }))).phase, { timeout: 90_000 }).toBe('ready')

  // La configuration du premier lancement (profil neuf) : passée.
  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
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
  const dialogs = () => shell.app.evaluate(() => (globalThis as unknown as { __dialogs: { message: string; detail: string }[] }).__dialogs)
  // Ce que le moteur a enregistré, lu par la commande sur le même profil.
  const stored = async () => cliRules(shell.root)

  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Agent et sécurité', exact: true }).first().click()
  const editor = page.getByTestId('permission-rules')
  await expect(editor).toBeVisible({ timeout: 30_000 })

  // 1. Un refus : durcir ne demande aucune boîte.
  await editor.getByLabel('Nom d’outil pour une nouvelle règle').fill('run_shell')
  await editor.getByLabel('Décision pour la nouvelle règle').selectOption('deny')
  await editor.getByRole('button', { name: 'Vérifier' }).click()
  await expect(editor.getByTestId('permission-plan')).toContainText('refuser « run_shell »')
  await editor.getByRole('button', { name: 'Appliquer' }).click()
  await expect(editor.getByTestId('permission-rule')).toHaveCount(1)
  expect(await dialogs()).toEqual([])

  // 2. Une autonomie bornée (dossier de démonstration, 3 utilisations, 8 heures) : aperçu, puis confirmation native qui la nomme.
  await editor.getByLabel('Nom d’outil pour une nouvelle règle').fill('system_files')
  await editor.getByLabel('Cible').fill('D:\\demo-e2e\\*')
  await editor.getByLabel('Décision pour la nouvelle règle').selectOption('auto')
  await editor.getByLabel('Utilisations (facultatif)').fill('3')
  await editor.getByLabel('Durée').selectOption('8')
  await editor.getByRole('button', { name: 'Vérifier' }).click()
  const plan = editor.getByTestId('permission-plan')
  await expect(plan).toContainText('autoriser SANS accord « system_files » sur « D:\\demo-e2e\\* »')
  await expect(plan).toContainText('3 utilisation(s) restante(s)')
  await expect(plan).toContainText('Cela donne plus de pouvoir')
  expect(await dialogs()).toEqual([]) // l'aperçu n'écrit rien et ne demande rien
  await editor.getByRole('button', { name: 'Appliquer' }).click()
  await expect(editor.getByTestId('permission-rule')).toHaveCount(2)
  expect((await dialogs()).at(-1)!.message).toMatch(/Affaiblir le garde de permissions/)
  expect((await dialogs()).at(-1)!.detail).toMatch(/system_files/)

  let rules = await stored()
  expect(rules[0]).toMatchObject({ tool: 'system_files', decision: 'allow', autonomous: true, target: 'D:\\demo-e2e\\*', uses: 3, by: 'réglages' })
  expect(rules[0]!.expiresAt! - Date.now()).toBeGreaterThan(7.9 * 3_600_000)
  const id = rules[0]!.id

  // 3. La commande lit la MÊME liste : même identifiant, mêmes bornes.
  const fromCli = cliRules(shell.root)
  expect(fromCli.map(r => r.id)).toEqual(rules.map(r => r.id))
  expect(fromCli[0]).toMatchObject({ id, uses: 3, target: 'D:\\demo-e2e\\*', by: 'réglages' })

  // 4. Modifier en place : 3 → 5 utilisations est annoncé et confirmé ; identifiant et position gardés.
  const count = (await dialogs()).length
  await editor.getByRole('button', { name: /Modifier la règle de system_files/ }).click()
  await editor.getByLabel('Utilisations (facultatif)').fill('5')
  await editor.getByRole('button', { name: 'Vérifier' }).click()
  await expect(editor.getByTestId('permission-plan')).toContainText('3 → 5 utilisation(s)')
  await editor.getByRole('button', { name: 'Appliquer' }).click()
  await expect.poll(async () => (await stored())[0]?.uses).toBe(5)
  expect((await dialogs()).length).toBe(count + 1)
  rules = await stored()
  expect(rules[0]!.id).toBe(id)

  // 5. Descendre l'autonomie sous le refus (durcit, sans boîte), puis la révoquer (durcit aussi).
  await editor.getByRole('button', { name: /Descendre system_files/ }).click()
  await expect.poll(async () => (await stored()).map(r => r.tool)).toEqual(['run_shell', 'system_files'])
  await editor.getByRole('button', { name: /Supprimer la règle de system_files/ }).click()
  await expect.poll(async () => (await stored()).map(r => r.tool)).toEqual(['run_shell'])
  expect((await dialogs()).length).toBe(count + 1)

  // 6. Retirer le refus AFFAIBLIT : la boîte native est demandée ; refusée, rien ne change.
  await shell.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dialogs: { message: string; detail: string }[] }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string }
      g.__dialogs.push({ message: options.message, detail: options.detail ?? '' })
      // « Annuler » : la réponse qui n'est pas l'action.
      return { response: 1, checkboxChecked: false }
    }) as never
  })
  await editor.getByRole('button', { name: /Supprimer la règle de run_shell/ }).click()
  await expect.poll(async () => (await dialogs()).length).toBe(count + 2)
  expect((await stored()).map(r => r.tool)).toEqual(['run_shell'])
  expect(cliRules(shell.root).map(r => r.tool)).toEqual(['run_shell'])
  expect(existsSync(profileOf(shell.root))).toBe(true)
})
