import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { type FakeModel, say, startFakeModel, toolCall } from './e2-support'
import { type Launched, launchShell } from './launch'

/*
 * V-02 proper — every call journaled, reads included — on the BUILT app: the real Electron shell and the real bundled core, against a scripted model
 * on 127.0.0.1 (no network). It needs the gate that writes a line for EVERY call, with its call id, tier, target and duration (`executeGuardedTool`);
 * the timeline view alone is covered by audit-timeline.spec.ts. Three turns in one conversation: a read that needs no approval, a command the person
 * approves on the card, a write the person refuses. Each call must leave exactly one audit line, shown under its own turn, with what was decided.
 *
 * Run `npm run bundle:core && npm run build` first. The shell runs in French here: assertions use the labels of src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

const KEY = ['sk', 'AUDIT-E2E-0123456789abcdef0123456'].join('-')

let shell: Launched
let page: Page
let model: FakeModel
let wsInfo: { wsUrl?: string; wsToken?: string }

/**
 * The test's own line to the gateway: model set-up and read-backs only, never an approval. Opened for one call and closed at once, since the
 * gateway asks the most recent connection for native gestures, which must stay the window's.
 */
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

interface Line {
  sessionId: string
  tool: string
  args: string
  decision: string
  ok?: boolean
  callId?: string
  tier?: string
  target?: string
  durationMs?: number
  proof?: string
  evidence?: string
}

/** Opens the conversation page, where each turn shows its audit timeline. */
async function openConversation(): Promise<void> {
  await page.keyboard.press('Control+2')
  await expect(page.getByPlaceholder(/^Demandez n’importe quoi à /).first()).toBeVisible({ timeout: 30_000 })
}

/** One turn: the scripted model calls `name`, then concludes; `decision` answers the approval card when there is one. */
async function turn(prompt: string, callId: string, name: string, args: Record<string, unknown>, decision?: 'Autoriser une fois' | 'Refuser'): Promise<void> {
  model.queue.push(toolCall(callId, name, args), say(`fini ${callId}`))

  const composer = page.getByPlaceholder(/^Demandez n’importe quoi à /).first()

  await composer.fill(prompt)
  await composer.press('Enter')

  if (decision) {
    const button = page.getByRole('button', { name: decision, exact: true })

    await expect(button).toBeVisible({ timeout: 60_000 })
    await button.click()
  }

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

test('a read, an approved command and a refused write each leave one audit line, under their own turn', async () => {
  await openConversation()
  await turn('liste le dossier', 'call-read', 'list_dir', { path: '.' })
  await turn('lance une commande', 'call-shell', 'run_shell', { command: 'echo audit-e2e' }, 'Autoriser une fois')
  await turn('écris un fichier', 'call-write', 'write_file', { path: 'refus.txt', content: 'non' }, 'Refuser')

  const timelines = page.getByTestId('audit-timeline')

  await expect(timelines).toHaveCount(3, { timeout: 15_000 })

  // Under each turn, its call and nothing else; the header counts it.
  const expected = [
    { tool: 'list_dir', decision: 'free', label: 'sans accord' },
    { tool: 'run_shell', decision: 'granted', label: 'accordé' },
    { tool: 'write_file', decision: 'refused', label: 'refusé par vous' }
  ]

  for (const [index, want] of expected.entries()) {
    const timeline = timelines.nth(index)

    await expect(timeline.getByRole('button')).toContainText('Journal d’audit · 1 appel')
    await timeline.getByRole('button').click()

    const rows = timeline.getByTestId('audit-line')

    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-tool', want.tool)
    await expect(rows.first()).toHaveAttribute('data-decision', want.decision)
    await expect(rows.first()).toContainText(want.label)
  }

  // The refusal is flagged on the collapsed row itself, and the command's target is shown.
  await expect(timelines.nth(2).getByRole('button')).toContainText('1 refusé')
  await expect(timelines.nth(1)).toContainText('echo audit-e2e')

  await page.screenshot({ path: path.join(test.info().outputDir, 'timeline-auditee.png'), fullPage: true })
})

test('the core serves the same three lines, in order, with their call ids, tiers, targets and durations', async () => {
  const { sessions } = await rpc<{ sessions: { id: string; message_count: number }[] }>('session.list', { limit: 10 })
  const conversation = sessions.find(s => s.message_count > 0)

  expect(conversation, 'the conversation of the first test').toBeDefined()

  const lines = await invoke<Line[]>('audit-session', conversation!.id)

  expect(lines.map(l => [l.callId, l.tool, l.decision, l.tier])).toEqual([
    ['call-read', 'list_dir', 'sans accord', 'ordinaire'],
    ['call-shell', 'run_shell', 'accordé', 'sensible'],
    ['call-write', 'write_file', 'refusé', 'sensible']
  ])
  expect(lines[0]!.ok).toBe(true)
  expect(lines[1]!.target).toContain('echo audit-e2e')
  // V-10 : la commande a sa preuve — le code de sortie relevé par le système, et ce qu'elle a changé dans le dossier de travail (rien).
  expect(lines[1]).toMatchObject({ proof: 'verified', evidence: expect.stringMatching(/^code de sortie 0 \(relevé par le système\) ; aucun fichier changé/) })
  expect(lines[2]!.target).toContain('refus.txt')
  // The approval wait is part of a call's duration; every line has one.
  expect(lines.every(l => typeof l.durationMs === 'number' && l.durationMs >= 0)).toBe(true)
  // A malformed id is refused, not answered with another conversation's lines.
  await expect(invoke('audit-session', '../x')).rejects.toThrow(/invalide/)
})
