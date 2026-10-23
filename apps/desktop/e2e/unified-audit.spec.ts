import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { type FakeModel, say, startFakeModel, toolCall } from './e2-support'
import { type Launched, launchShell } from './launch'

/*
 * V-03 — one view for the four audit journals, on the BUILT app (real Electron shell, real bundled core, scripted model on 127.0.0.1, no network):
 *  - agent      : a real turn whose `list_dir` call the core journals (SQLite, `audit` stream) ;
 *  - bridge     : `audit.jsonl` lines written where the Python bridge writes them (the bridge itself is not run here) ;
 *  - control    : a `control-audit.jsonl` line, same file as the shell's control channel and the Rust host ;
 *  - mcp-server : a `mcp-server.log` line in the core's data root, where `jarod mcp` writes it ;
 *  - download   : a `download-quarantine.jsonl` decision, where the shell's download quarantine writes it (V-07).
 * The seeded lines use the formats the writers' own tests pin (c3 fixtures, `mcp-server.test.ts`). Réglages › Confidentialité › « Voir le journal »
 * must show all four, newest first, and its filters must narrow them. Run `npm run bundle:core && npm run build` first; labels from src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

const KEY = ['sk', 'AUDIT-V03-0123456789abcdef0123456'].join('-')
const REQUEST = 'br-e2e000000003'

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

const append = (file: string, lines: unknown[]) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, lines.map(line => `${typeof line === 'string' ? line : JSON.stringify(line)}\n`).join(''))
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

  // One real agent call: a read, journaled by the core's gate.
  await page.keyboard.press('Control+2')
  const composer = page.getByPlaceholder(/^Demandez n’importe quoi à /).first()

  await expect(composer).toBeVisible({ timeout: 30_000 })
  model.queue.push(toolCall('call-v03', 'list_dir', { path: '.' }), say('fini v03'))
  await composer.fill('liste le dossier')
  await composer.press('Enter')
  await expect(page.getByText('fini v03').first()).toBeVisible({ timeout: 60_000 })

  // The four file journals, in their writers' formats, a few seconds in the future so they sort above the agent's line.
  const soon = (s: number) => new Date(Date.now() + s * 1000).toISOString()
  const shellData = path.join(shell.root, 'hermes', 'jarod-os')

  append(path.join(shellData, 'audit.jsonl'), [
    { ts: soon(2), tool: 'system_kill_process', tier: 'destructive', action: 'kill', decision: 'denied', ok: false, summary: null, error: 'refusé par la personne', requestId: REQUEST, args: { pid: 4242 } }
  ])
  append(path.join(shellData, 'control-audit.jsonl'), [{ at: soon(3), client: 'backend', cmd: 'system', command: 'kill', tier: 'destructive', allowed: false, reason: 'approval refused', code: 'approval-refused', requestId: REQUEST, surface: 'backend' }])
  append(path.join(shell.root, 'data', 'profile', 'mcp-server.log'), [`${soon(4)} memory_search args=12o résultat=345o ok`])
  append(path.join(shellData, 'download-quarantine.jsonl'), [
    { at: soon(5), site: 'browser', host: 'files.example', name: 'notes.txt', outcome: 'admitted', sha256: 'cd'.repeat(32), size: 20, scanner: 'defender', verdict: 'clean' }
  ])
})

test.afterAll(async () => {
  await shell?.close()
  await model?.close()
})

test('the core serves its part: the agent line and the mcp-server.log line', async () => {
  const part = await invoke<{ agent: { tool: string; callId?: string }[]; mcpServer: string[] }>('audit-recent')

  expect(part.agent.some(l => l.tool === 'list_dir' && l.callId === 'call-v03')).toBe(true)
  expect(part.mcpServer.some(l => l.includes('memory_search'))).toBe(true)
})

test('Réglages › Confidentialité shows the five journals in one list, newest first, and its filters narrow it', async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Confidentialité', exact: true }).first().click()
  await page.getByRole('button', { name: 'Voir le journal', exact: true }).click()

  const rows = page.getByTestId('unified-audit-line')

  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="unified-audit-line"][data-source="agent"][data-tool="list_dir"]')).toHaveCount(1)
  // Newest first: the three seeded lines (2 s, 3 s, 4 s ahead) above the agent's.
  const order = await rows.evaluateAll(els => els.map(el => el.getAttribute('data-source')))

  expect(order.slice(0, 5)).toEqual(['download', 'mcp-server', 'control', 'bridge', 'agent'])
  await expect(page.locator('[data-testid="unified-audit-line"][data-source="download"]')).toContainText('defender : clean')
  // The bridge line and the control line of the same attempt carry the same request id.
  await expect(page.locator('[data-testid="unified-audit-line"][data-source="bridge"]')).toContainText(REQUEST)
  await expect(page.locator('[data-testid="unified-audit-line"][data-source="control"]')).toContainText(REQUEST)

  await rows.last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(test.info().outputDir, 'journal-unique.png'), fullPage: true })

  // Refusals and failures only: the two refusals stay, the agent's read and the MCP call go.
  await page.getByRole('button', { name: 'Refus et échecs', exact: true }).click()
  await expect(page.locator('[data-testid="unified-audit-line"][data-outcome="ok"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="unified-audit-line"][data-outcome="refused"]')).toHaveCount(2)
  await page.getByRole('button', { name: 'Refus et échecs', exact: true }).click()

  // A source unticked disappears; the text filter searches tools, details and ids.
  await page.getByRole('button', { name: 'Clients MCP', exact: true }).click()
  await expect(page.locator('[data-testid="unified-audit-line"][data-source="mcp-server"]')).toHaveCount(0)
  await page.locator('button[aria-pressed]', { hasText: 'Téléchargements' }).click()
  await expect(page.locator('[data-testid="unified-audit-line"][data-source="download"]')).toHaveCount(0)
  await page.getByLabel('Filtrer par outil, détail ou identifiant…').fill(REQUEST)
  await expect(rows).toHaveCount(2)
})
