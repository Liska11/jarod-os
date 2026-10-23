import { expect, test, type Page } from '@playwright/test'
import { type FakeModel, say, startFakeModel, toolCall } from './e2-support'
import { type Launched, launchShell } from './launch'

/*
 * V-08 — the per-turn timeline on the BUILT app (real shell, real bundled core, scripted model on 127.0.0.1, no network): two turns write the
 * same file, each approved on its card. Under the second turn: the result card says « 1 fichier modifié », the write's line carries what its
 * verification observed (the file read back), and « Changements de ce tour » shows that turn's own change (+2 −1, not the first turn's), with
 * its diff. Run `npm run bundle:core && npm run build` first; labels from src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

const KEY = ['sk', 'TURN-E2E-0123456789abcdef01234567'].join('-')

let shell: Launched
let page: Page
let model: FakeModel
let wsInfo: { wsUrl?: string; wsToken?: string }

async function rpc<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
  const ws = new WebSocket(`${wsInfo.wsUrl}?token=${wsInfo.wsToken}`)

  try {
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok())
      ws.addEventListener('error', () => bad(new Error('control line refused')))
    })

    return await new Promise<T>((ok, bad) => {
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: T; error?: { message?: string } }

        if (frame.id === 1) {
          frame.error ? bad(new Error(frame.error.message ?? 'error')) : ok(frame.result as T)
        }
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
    })
  } finally {
    ws.close()
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

const invoke = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => (await rpc<{ result: T }>('jarod.invoke', { channel, args })).result

async function turn(prompt: string, callId: string, content: string): Promise<void> {
  model.queue.push(toolCall(callId, 'write_file', { path: 'notes.txt', content }), say(`fini ${callId}`))

  const composer = page.getByPlaceholder(/^Demandez n’importe quoi à /).first()

  await composer.fill(prompt)
  await composer.press('Enter')
  const allow = page.getByRole('button', { name: 'Autoriser une fois', exact: true })

  await expect(allow).toBeVisible({ timeout: 60_000 })
  await allow.click()
  await expect(page.getByText(`fini ${callId}`).first()).toBeVisible({ timeout: 60_000 })
}

test.beforeAll(async () => {
  model = await startFakeModel({ toolTurnsOnly: true })
  shell = await launchShell({ JAROD_CUSTOM_API_KEY: KEY })
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) {
      break
    }

    await next.first().click()
    await page.waitForTimeout(600)
  }

  wsInfo = await page.evaluate(() => window.jarodOS.backend.getState())
  await invoke('add-model', 'e2e', 'custom', 'jarod-test-model', `http://127.0.0.1:${model.port}/v1`)
  await rpc('config.set', { key: 'model', value: 'custom:jarod-test-model' })
  await invoke('set-jarod-settings', { toolSearch: 'off', autoTitle: false })
})

test.afterAll(async () => {
  await shell?.close()
  await model?.close()
})

test('under each turn: a result card, the verification’s finding, and that turn’s own diff', async () => {
  await page.keyboard.press('Control+2')
  await expect(page.getByPlaceholder(/^Demandez n’importe quoi à /).first()).toBeVisible({ timeout: 30_000 })

  await turn('écris les notes', 'call-w1', 'un\ndeux\ntrois\n')
  await turn('corrige les notes', 'call-w2', 'un\nDEUX\ntrois\nquatre\n')

  const timelines = page.getByTestId('audit-timeline')

  await expect(timelines).toHaveCount(2, { timeout: 15_000 })
  const second = timelines.nth(1)

  await expect(second.getByTestId('audit-summary')).toContainText('1 fichier modifié')
  await second.getByRole('button', { name: /journal d’audit de ce tour/ }).click()
  await expect(second.getByTestId('audit-evidence')).toContainText(/notes\.txt relu : \d+ octets, contenu identique/)

  const file = second.getByTestId('audit-file')

  await expect(file).toHaveAttribute('data-path', 'notes.txt', { timeout: 15_000 })
  await expect(file).toHaveAttribute('data-status', 'modified')
  await expect(file).toContainText('+2')
  await expect(file).toContainText('−1')
  await file.getByRole('button').click()
  const diff = second.getByTestId('audit-diff')

  await expect(diff).toContainText('− deux')
  await expect(diff).toContainText('+ DEUX')
  await expect(diff).toContainText('+ quatre')

  // The first turn shows ITS change: the file created, three lines.
  const first = timelines.nth(0)

  await first.getByRole('button', { name: /journal d’audit de ce tour/ }).click()
  await expect(first.getByTestId('audit-file')).toHaveAttribute('data-status', 'created', { timeout: 15_000 })
  await expect(first.getByTestId('audit-file')).toContainText('+3')

  await second.screenshot({ path: test.info().outputPath('timeline-tour.png') })
})
