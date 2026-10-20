import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { invokeCore } from './e2-support'
import { type Launched, launchShell } from './launch'

/*
 * Missions, Kanban and Automations with real data, in a throwaway profile, on the built app and its bundled core. Nothing here needs a model: no
 * provider is configured, and only the paths that work without one are used (Kanban's board, cron jobs in the scheduler, a mission's session). The
 * last test relaunches on the same root and checks that everything created before is still there.
 *
 * The shell runs in French here: the assertions use the labels of src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page

async function skipSetup(target: Page): Promise<void> {
  await expect(target.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = target.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click()
    await target.waitForTimeout(800)
  }
}

const nav = (target: Page, name: string) => target.getByRole('navigation').first().getByRole('button', { name, exact: true }).click()
interface Job {
  name: string
  prompt: string
  enabled: boolean
  state: string
  schedule: { kind: string; minutes?: number }
}

/** The cron jobs as the core serves them (the same REST the page reads). */
const fetchJobs = () => page.evaluate(() => window.jarodOS.backend.rest<Job[]>({ method: 'GET', path: '/api/cron/jobs' }))
const kanbanTasks = async () => {
  const state = await page.evaluate(() => window.jarodOS.backend.getState())
  const answer = await invokeCore<{ data: { title: string; status: string; priority: number; body: string | null; assignee: string | null }[] }>(state, 'kanban-list-tasks', {})

  return answer.data
}
const shot = (name: string) => page.screenshot({ path: path.join(process.env.AUDIT_SHOTS ?? shell.root, `${name}.png`) }).catch(() => undefined)

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await skipSetup(page)
})

test.afterAll(async () => {
  await shell?.close()
})

test.describe('kanban', () => {
  const column = (name: string) => page.getByRole('region', { name, exact: true })
  const card = (title: string) => page.getByRole('button', { name: `Ouvrir ${title}`, exact: true })
  const drawer = () => page.getByRole('complementary', { name: 'Détails de la tâche' })

  test('a task is created through the form and listed in its column', async () => {
    await nav(page, 'Kanban')
    await expect(page.getByText('Pas encore de tâche')).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Nouvelle tâche' }).first().click()
    await page.getByRole('textbox', { name: 'Titre de la tâche' }).fill('Ranger les factures')
    await page.getByRole('textbox', { name: 'Détails de la tâche' }).fill('Classer par mois.')
    await page.getByRole('textbox', { name: 'Priorité' }).fill('2')
    await page.getByRole('button', { name: 'Ajouter la tâche' }).click()

    await expect(card('Ranger les factures')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('textbox', { name: 'Titre de la tâche' })).toHaveCount(0)

    // A second, rough one: « to specify first » lands in its own column.
    await page.getByRole('button', { name: 'Nouvelle tâche' }).first().click()
    await page.getByRole('textbox', { name: 'Titre de la tâche' }).fill('Idée vague')
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: 'Ajouter la tâche' }).click()
    await expect(card('Idée vague')).toBeVisible({ timeout: 15_000 })

    const list = await kanbanTasks()

    // No assignee typed: the task goes to the served profile (« Run next » skipped unassigned tasks for good).
    expect(list.find(t => t.title === 'Ranger les factures')).toMatchObject({ status: 'ready', priority: 2, body: 'Classer par mois.', assignee: 'default' })
    expect(list.find(t => t.title === 'Idée vague')).toMatchObject({ status: 'triage' })
  })

  test('a refused task (bad priority) cannot be submitted', async () => {
    await page.getByRole('button', { name: 'Nouvelle tâche' }).first().click()
    await page.getByRole('textbox', { name: 'Titre de la tâche' }).fill('Mauvaise priorité')
    await page.getByRole('textbox', { name: 'Priorité' }).fill('haute')
    await expect(page.getByRole('button', { name: 'Ajouter la tâche' })).toBeDisabled()
    await page.getByRole('button', { name: 'Annuler' }).click()
    await expect(card('Mauvaise priorité')).toHaveCount(0)
  })

  test('a task moves across the columns: ready → scheduled → ready → blocked → ready → done, with a comment', async () => {
    const at = (name: string) => expect(column(name).getByRole('button', { name: 'Ouvrir Ranger les factures' })).toBeVisible({ timeout: 15_000 })

    await card('Ranger les factures').click()
    await expect(drawer()).toBeVisible()
    await expect(drawer().getByText('Classer par mois.')).toBeVisible()

    // Comment (edits the task's thread).
    await drawer().getByRole('button', { name: 'Comment', exact: true }).click()
    await drawer().getByRole('textbox').fill('Commencer par janvier.')
    await drawer().getByRole('button', { name: 'Comment', exact: true }).last().click()
    await expect(drawer().getByText('Commencer par janvier.')).toBeVisible({ timeout: 15_000 })

    // Set aside for later, then brought back (the « unblock » the engine accepts on a scheduled task).
    await drawer().getByRole('button', { name: 'Schedule for later', exact: true }).click()
    await drawer().getByRole('button', { name: 'Schedule for later', exact: true }).last().click()
    await at('Scheduled')
    await drawer().getByRole('button', { name: 'Unblock', exact: true }).click()
    await at('Ready')

    // Block with a reason, then unblock.
    await drawer().getByRole('button', { name: 'Block', exact: true }).click()
    await drawer().getByRole('textbox').fill('Il manque le relevé.')
    await drawer().getByRole('button', { name: 'Block', exact: true }).last().click()
    await at('Blocked')
    await drawer().getByRole('button', { name: 'Unblock', exact: true }).click()
    await at('Ready')

    // Complete with a result.
    await drawer().getByRole('button', { name: 'Complete', exact: true }).click()
    await drawer().getByRole('textbox').fill('Factures classées.')
    await drawer().getByRole('button', { name: 'Complete', exact: true }).last().click()
    await at('Done')
    await expect(drawer().getByText('Factures classées.')).toBeVisible()
    await shot('kanban-moved')
    await drawer().getByRole('button', { name: 'Fermer' }).click()

    expect((await kanbanTasks()).find(t => t.title === 'Ranger les factures')).toMatchObject({ status: 'done' })
  })

  test('a rough idea offers only what the engine accepts there (no « Mark ready », which it always refused)', async () => {
    await card('Idée vague').click()
    await expect(drawer().getByRole('button', { name: 'Ask the agent to specify', exact: true })).toBeVisible()
    await expect(drawer().getByRole('button', { name: 'Mark ready', exact: true })).toHaveCount(0)
    await drawer().getByRole('button', { name: 'Fermer' }).click()
  })

  test('« what next » names the ready task without starting anything', async () => {
    await page.getByRole('button', { name: 'Nouvelle tâche' }).first().click()
    await page.getByRole('textbox', { name: 'Titre de la tâche' }).fill('Trier les photos')
    await page.getByRole('button', { name: 'Ajouter la tâche' }).click()
    await expect(card('Trier les photos')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Quelle est la suivante ?' }).click()
    await expect(page.getByText('Next up: “Trier les photos”.')).toBeVisible({ timeout: 15_000 })
    expect((await kanbanTasks()).find(t => t.title === 'Trier les photos')).toMatchObject({ status: 'ready' })
  })

  test('archiving a task removes it from the board', async () => {
    await card('Idée vague').click()
    await drawer().getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(card('Idée vague')).toHaveCount(0, { timeout: 15_000 })
    await expect(drawer()).toHaveCount(0)
  })

  test('a second board is created, switched to, and is empty', async () => {
    await page.getByRole('button', { name: 'Nouveau tableau' }).click()
    await page.getByPlaceholder('Nom du tableau').fill('Maison')
    await page.getByRole('button', { name: 'Créer', exact: true }).click()
    await expect(page.getByText('Pas encore de tâche')).toBeVisible({ timeout: 15_000 })

    const picker = page.getByRole('combobox', { name: 'Tableau' })

    await expect(picker).toHaveValue('maison')
    await picker.selectOption({ label: (await picker.locator('option').first().innerText()).trim() })
    await expect(card('Ranger les factures')).toBeVisible({ timeout: 15_000 })
  })
})

test.describe('automations', () => {
  const jobCard = (name: string) => page.getByRole('button', { name: `Ouvrir ${name}`, exact: true })

  test('an automation is created through the form and listed', async () => {
    await nav(page, 'Automatisations')
    await expect(page.getByText('Aucune automatisation pour le moment')).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Nouvelle automatisation' }).first().click()
    await page.locator('#new-automation-name').fill('Revue du matin')
    await page.locator('#new-automation-schedule').fill('every 6h')
    await page.locator('#new-automation-prompt').fill('Résumer les nouveaux fichiers du dossier de travail.')
    // The assistant is named Jarod here: no « Hermes » left in the form (labels, hints, the delivery choice).
    await expect(page.getByText('Ce que Jarod doit faire')).toBeVisible()
    expect(await page.locator('#new-automation-deliver').textContent()).toContain('Jarod (local)')
    expect(await page.locator('form').first().textContent()).not.toContain('Hermes')
    await page.getByRole('button', { name: 'Nouvelle automatisation' }).last().click()

    await expect(jobCard('Revue du matin')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Revue du matin' })).toBeVisible()
  })

  test('its prompt and schedule are edited in the detail and saved by the core', async () => {
    await page.getByRole('button', { name: 'Modifier Rassembler' }).click()
    await page.locator('#automation-prompt').fill('Résumer les fichiers modifiés aujourd’hui.')
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()
    await expect(page.getByText('Modifications enregistrées').first()).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Modifier Quand' }).click()
    await page.locator('#automation-schedule').fill('every 2h')
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click()

    await expect
      .poll(async () => {
        const jobs = await fetchJobs()

        return jobs.find(j => j.name === 'Revue du matin')
      })
      .toMatchObject({ prompt: 'Résumer les fichiers modifiés aujourd’hui.', schedule: { kind: 'interval', minutes: 120 } })
  })

  test('it is paused and resumed with its switch', async () => {
    const toggle = page.getByRole('switch', { name: /Revue du matin$/ })

    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(page.getByRole('switch', { name: 'Reprendre Revue du matin' })).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 })
    await expect(page.getByText('En pause', { exact: true }).filter({ visible: true }).first()).toBeVisible()
    expect((await fetchJobs()).find(j => j.name === 'Revue du matin')).toMatchObject({ enabled: false, state: 'paused' })

    await page.getByRole('switch', { name: 'Reprendre Revue du matin' }).click()
    await expect(page.getByRole('switch', { name: 'Mettre en pause Revue du matin' })).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 })
    expect((await fetchJobs()).find(j => j.name === 'Revue du matin')).toMatchObject({ enabled: true })
  })

  test('a duplicate is made, then deleted after the inline confirmation', async () => {
    await page.getByRole('button', { name: 'Autres actions pour Revue du matin' }).first().click()
    await page.getByRole('menuitem', { name: 'Dupliquer' }).click()
    await expect(jobCard('Revue du matin copy')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'Autres actions pour Revue du matin copy' }).first().click()
    await page.getByRole('menuitem', { name: 'Supprimer' }).click()
    await expect(jobCard('Revue du matin copy')).toBeVisible()
    await page.getByRole('menuitem', { name: 'Confirmer la suppression' }).click()
    await expect(jobCard('Revue du matin copy')).toHaveCount(0, { timeout: 15_000 })
    expect((await fetchJobs()).map(j => j.name)).toEqual(['Revue du matin'])
    await shot('automations')
  })

  test('a schedule the core cannot read is refused with its reason, and nothing is created', async () => {
    await page.getByRole('button', { name: 'Nouvelle automatisation' }).first().click()
    await page.locator('#new-automation-name').fill('Jamais')
    await page.locator('#new-automation-schedule').fill('quand il pleut')
    await page.locator('#new-automation-prompt').fill('Rien.')
    await page.getByRole('button', { name: 'Nouvelle automatisation' }).last().click()
    await expect(page.locator('#new-automation-name')).toBeVisible()
    await expect(jobCard('Jamais')).toHaveCount(0)
    expect((await fetchJobs()).map(j => j.name)).toEqual(['Revue du matin'])
    await expect(page.getByText('Impossible de créer l’automatisation').first()).toBeVisible()
    await page.getByRole('button', { name: 'Fermer le formulaire de nouvelle automatisation' }).click()
    await expect(page.locator('#new-automation-name')).toHaveCount(0)
  })
})

const missionCard = () => page.locator('[data-os-target^="mission:"]').filter({ hasText: 'Préparer le bilan de la semaine' })

test.describe('missions', () => {
  test('a mission started from the composer whose turn fails (no model) waits « to review », not « completed »', async () => {
    await nav(page, 'Missions')
    await expect(page.getByText('Aucune mission en cours')).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Nouvelle mission' }).first().click()
    await page.getByRole('textbox', { name: 'Objectif de la mission' }).fill('Préparer le bilan de la semaine')
    await page.getByRole('button', { name: 'Lancer la mission' }).click()

    // Starting a mission opens its conversation: the user's goal is there; the turn cannot run (no provider configured).
    await expect(page.getByTestId('user-message').filter({ hasText: 'Préparer le bilan de la semaine' })).toBeVisible({ timeout: 30_000 })

    await nav(page, 'Missions')
    await expect(page.getByRole('tab', { name: 'À examiner 1' })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('tab', { name: 'Terminées 0' })).toBeVisible()
    await page.getByRole('tab', { name: 'À examiner 1' }).click()
    await missionCard().first().click()
    await expect(page.getByRole('heading', { name: 'Préparer le bilan de la semaine' })).toBeVisible()
    await shot('missions')
  })
})

test('everything is still there after a relaunch on the same root', async () => {
  const root = shell.root

  await shell.app.close()
  shell = await launchShell({}, { root, own: true })
  page = shell.page
  await skipSetup(page)

  await nav(page, 'Kanban')
  await expect(page.getByRole('button', { name: 'Ouvrir Ranger les factures', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('region', { name: 'Done', exact: true }).getByRole('button', { name: 'Ouvrir Ranger les factures' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ouvrir Idée vague', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Tableau' })).toBeVisible()

  await nav(page, 'Automatisations')
  await expect(page.getByRole('button', { name: 'Ouvrir Revue du matin', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('switch', { name: 'Mettre en pause Revue du matin' })).toHaveAttribute('aria-checked', 'true')
  expect((await fetchJobs()).find(j => j.name === 'Revue du matin')).toMatchObject({ prompt: 'Résumer les fichiers modifiés aujourd’hui.', schedule: { minutes: 120 } })

  // The mission is a stored session: it is still listed (in whichever tab its derived status puts it).
  await nav(page, 'Missions')
  await expect.poll(async () => {
    for (const tab of await page.getByRole('tab').all()) {
      await tab.click()

      if (await missionCard().count()) return true
    }

    return false
  }, { timeout: 30_000 }).toBe(true)
})
