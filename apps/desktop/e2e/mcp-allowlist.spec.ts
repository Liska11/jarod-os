import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

/*
 * V-14 — MCP allowlist, tool by tool, on the BUILT app (real shell, real bundled core, throwaway profile) with a real stdio MCP server (the
 * plugin-mcp fixture, run by this test's Node): Réglages › Serveurs MCP › Outils reads the server's tools live, the person keeps one, and the
 * agent's registry then holds that tool only — the other does not exist for the agent. "All tools" brings both back. Run `npm run bundle:core &&
 * npm run build` first; labels from src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

const FAKE_MCP = path.resolve(import.meta.dirname, '..', '..', '..', 'jarod-core', 'packages', 'plugins', 'mcp', 'test', 'fixtures', 'fake-mcp.mjs')

let shell: Launched
let page: Page
let wsInfo: { wsUrl?: string; wsToken?: string }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const ws = new WebSocket(`${wsInfo.wsUrl}?token=${wsInfo.wsToken}`)

  try {
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok())
      ws.addEventListener('error', () => bad(new Error('control line refused')))
    })

    return await new Promise<T>((ok, bad) => {
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: { result: T }; error?: { message?: string } }

        if (frame.id === 1) {
          frame.error ? bad(new Error(frame.error.message ?? 'error')) : ok(frame.result!.result)
        }
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'jarod.invoke', params: { channel, args } }))
    })
  } finally {
    ws.close()
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

const agentTools = async () => (await invoke<{ key: string }[]>('get-toolsets')).map(tool => tool.key).filter(key => key.startsWith('mcp_fake_')).sort()

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

  wsInfo = await page.evaluate(() => window.jarodOS.backend.getState())
  expect(await invoke('add-mcp-server', { name: 'fake', type: 'stdio', command: process.execPath, args: [FAKE_MCP] })).toEqual({ success: true })
  await expect.poll(agentTools, { timeout: 30_000 }).toEqual(['mcp_fake_boom', 'mcp_fake_echo'])
})

test.afterAll(async () => {
  await shell?.close()
})

test('Réglages › Serveurs MCP › Outils: keep one tool, the agent loses the other; all tools brings it back', async () => {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Serveurs MCP', exact: true }).first().click()
  await page.getByRole('button', { name: 'Choisir les outils de fake' }).click()

  const picker = page.getByTestId('mcp-tools-fake')

  await expect(picker.getByRole('checkbox', { name: 'echo' })).toBeVisible({ timeout: 30_000 })
  await picker.getByRole('checkbox', { name: 'Tous les outils du serveur' }).uncheck()
  await picker.getByRole('checkbox', { name: 'echo' }).check()
  await picker.screenshot({ path: test.info().outputPath('outils-mcp.png') })
  await picker.getByRole('button', { name: 'Enregistrer' }).click()

  await expect(page.getByTestId('mcp-allowlist-fake')).toHaveText('1 outil(s) choisi(s)', { timeout: 30_000 })
  expect((await invoke<{ name: string; allowedTools?: string[] }[]>('list-mcp-servers')).find(s => s.name === 'fake')?.allowedTools).toEqual(['echo'])
  await expect.poll(agentTools, { timeout: 30_000 }).toEqual(['mcp_fake_echo'])

  await page.getByRole('button', { name: 'Choisir les outils de fake' }).click()
  await expect(picker.getByRole('checkbox', { name: 'boom' })).not.toBeChecked({ timeout: 30_000 })
  await picker.getByRole('checkbox', { name: 'Tous les outils du serveur' }).check()
  await picker.getByRole('button', { name: 'Enregistrer' }).click()

  await expect(page.getByTestId('mcp-allowlist-fake')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(agentTools, { timeout: 30_000 }).toEqual(['mcp_fake_boom', 'mcp_fake_echo'])
})
