import { expect, type Page, test } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { say, startFakeModel, startSite, toolCall } from './e2-support'
import { type Launched, launchShell, ROOT_PREFIX, removeRoot } from './launch'

/*
 * V-22 — the agent-traffic bench of the Rust adjudicator in shadow (`jarod-control-shadow`, a debug build of host-rust/crates/host-control).
 *
 *   npm run bundle:core && npm run build && npx playwright test e2e/control-shadow-agent.spec.ts
 *
 * Real agent turns on the BUILT app, flag on, throwaway profile: the model is scripted (a fake OpenAI server on 127.0.0.1, no network), and
 * everything after it is real — the agent loop, its tools, the shell's control door, the native approval (answered in main). The test sends
 * nothing to the door: every request the shadow sees came from an agent's tool. On Windows two paths reach the door:
 *  - the native core: `pinokio_open`, which asks the window to show a local page (`ui pinokio.show`, act);
 *  - Hermes with the Jarod-OS bridge: `os_ui` list, state and run — a read command, then act, mutate (approved) and destructive (denied), each
 *    on an automation that does not exist, so nothing changes whatever the shell does.
 * After quitting, the counter (`control-shadow-stats.json`) and the divergence file are read. Skipped without the binary; the Hermes part
 * runs the PACKAGED app (`npm run dist:win`: only it installs the bridge) and is skipped without it or without Hermes Agent (its first start
 * prepares a Python environment: minutes).
 */
test.describe.configure({ mode: 'serial' })

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BIN = process.env.JAROD_CONTROL_SHADOW_BIN ?? path.join(REPO, 'host-rust', 'target', 'debug', 'jarod-control-shadow.exe')
const CONTRACTS = path.join(REPO, 'contracts', 'v1')
const SHADOW = { JAROD_HOST_CONTROL: '1', JAROD_CONTROL_SHADOW_BIN: BIN, JAROD_OS_CONTRACTS_DIR: CONTRACTS }
const KEY = ['sk', 'SHADOW-E2E-0123456789abcdef01234567'].join('-')
const HERMES_ROOT = path.join(process.env.LOCALAPPDATA ?? '', 'hermes', 'hermes-agent')
const hermesInstalled = fs.existsSync(path.join(HERMES_ROOT, 'venv', 'Scripts', 'python.exe'))
// Only the PACKAGED app installs the bridge into Hermes (it ships it in its resources, enables it and its toolset, and turns
// Hermes's tool search off so `os_ui` is offered directly); a checkout started with `electron .` has no bridge to give. `npm run dist:win`.
const PACKAGED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'release', 'win-unpacked', 'Jarod-OS.exe')

test.skip(!fs.existsSync(BIN), 'jarod-control-shadow is not built')

interface Stats {
  compared: number
  diverged: number
  known: number
  dropped: number
  stopReason: string | null
  byCommand: Record<string, { compared: number; diverged: number; known: number; tiers: Record<string, number> }>
}

/** Quits the app, then reads what the shadow kept: its counts (last written at quit) and any divergence. */
async function quitAndRead(shell: Launched, name: string): Promise<{ stats: Stats; divergences: string[] }> {
  await shell.app.close().catch(() => undefined)
  const config = path.join(shell.root, 'config')
  const stats = JSON.parse(fs.readFileSync(path.join(config, 'control-shadow-stats.json'), 'utf8')) as Stats
  const file = path.join(config, 'control-shadow.jsonl')
  const divergences = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
  const report = { ...stats, divergences }

  console.log(`control-shadow, ${name}: ${JSON.stringify(report, null, 1)}`)
  await test.info().attach(`control-shadow-${name}.json`, { body: JSON.stringify(report, null, 1), contentType: 'application/json' })

  return { stats, divergences }
}

async function skipSetup(page: Page): Promise<void> {
  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click({ timeout: 5_000, force: true }).catch(() => undefined)
    await page.waitForTimeout(800)
  }
}

/** Every native confirmation answered in main: `allow` decides from its message (« Allow this mutate request? »); the messages are kept. */
async function answerApprovals(shell: Launched, allowTiers: string[]): Promise<void> {
  await shell.app.evaluate(({ dialog }, allow) => {
    const g = globalThis as unknown as { __asked?: string[] }

    g.__asked = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const message = String((args.at(-1) as { message?: string }).message ?? '')

      g.__asked?.push(message)

      return { response: allow.some(tier => message.includes(` ${tier} `)) ? 1 : 0, checkboxChecked: false }
    }) as never
  }, allowTiers)
}

const asked = (shell: Launched) => shell.app.evaluate(() => (globalThis as unknown as { __asked?: string[] }).__asked ?? [])

test('native core: an agent’s pinokio_open goes through the door and the shadow agrees', async () => {
  test.setTimeout(240_000)
  const model = await startFakeModel({ toolTurnsOnly: true })
  const site = await startSite()
  const root = fs.mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const shell = await launchShell({ ...SHADOW, JAROD_CUSTOM_API_KEY: KEY }, { root, own: false })
  const { page } = shell

  try {
    await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
    await skipSetup(page)
    await expect.poll(async () => (await page.evaluate(() => window.jarodOS.backend.getState())).phase, { timeout: 90_000 }).toBe('ready')
    const { wsUrl, wsToken } = await page.evaluate(() => window.jarodOS.backend.getState())
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const ws = new WebSocket(`${wsUrl}?token=${wsToken}`)

      try {
        await new Promise<void>((ok, bad) => (ws.addEventListener('open', () => ok()), ws.addEventListener('error', () => bad(new Error('refused')))))

        return await new Promise((ok, bad) => {
          ws.addEventListener('message', event => {
            const frame = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }

            if (frame.id === 1) frame.error ? bad(new Error(frame.error.message)) : ok(frame.result)
          })
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
        })
      } finally {
        ws.close()
      }
    }

    await rpc('jarod.invoke', { channel: 'add-model', args: ['e2e', 'custom', 'jarod-test-model', `http://127.0.0.1:${model.port}/v1`] })
    await rpc('config.set', { key: 'model', value: 'custom:jarod-test-model' })
    await rpc('jarod.invoke', { channel: 'set-jarod-settings', args: [{ toolSearch: 'off', autoTitle: false }] })

    model.queue.push(toolCall('call-pinokio-open', 'pinokio_open', { url: site.url('/') }), say('fini pinokio'))
    await page.keyboard.press('Control+2')
    const composer = page.getByPlaceholder(/^Demandez n’importe quoi à /).first()

    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill('montre la page de l’app')
    await composer.press('Enter')
    await expect(page.getByText('fini pinokio').first()).toBeVisible({ timeout: 90_000 })
    expect(model.offered.flat()).toContain('pinokio_open')
    await page.waitForTimeout(1_500)
  } finally {
    const { stats, divergences } = await quitAndRead(shell, 'native-core').finally(async () => {
      await model.close()
      await site.close()
    })

    await removeRoot(root)
    expect(divergences).toEqual([])
    expect(stats).toMatchObject({ diverged: 0, dropped: 0, stopReason: 'app quit' })
    expect(stats.byCommand['backend:ui']?.compared ?? 0).toBeGreaterThan(0)
  }
})

test('Hermes: the bridge’s os_ui — list, state, read, act, mutate approved, destructive denied — goes through the door and the shadow agrees', async () => {
  test.skip(!hermesInstalled, 'Hermes Agent is not installed on this machine')
  test.skip(!fs.existsSync(PACKAGED), 'no packaged app (npm run dist:win): only it carries the bridge')
  test.setTimeout(900_000)

  const DONE = 'SHADOW_AGENT_DONE'
  const absent = 'shadow-bench-absent'
  const os = (args: Record<string, unknown>) => ({ name: 'os_ui', args })
  const script = [
    os({ action: 'list' }),
    os({ action: 'state' }),
    os({ action: 'run', command: 'page.open', args: { name: 'memory' } }),
    os({ action: 'run', command: 'automation.run', args: { name: absent } }),
    os({ action: 'run', command: 'automation.pause', args: { name: absent } }),
    os({ action: 'run', command: 'automation.delete', args: { name: absent } }),
  ]
  const offered: string[][] = []
  /** What each tool returned to the model (the start of it): the first place a refusal shows. */
  const results: string[] = []
  let step = 0
  /** The model's last word of the turn was served (the chat may be off screen: the agent itself opened another page). */
  let doneServed = false
  const provider = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))

        return
      }

      const body = raw ? (JSON.parse(raw) as { tools?: { function: { name: string } }[]; messages?: { role: string; content?: unknown }[] }) : {}
      const tools = (body.tools ?? []).map(tool => tool.function.name)
      offered.push(tools)
      const last = body.messages?.at(-1)
      if (last?.role === 'tool') results.push(String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content)).slice(0, 400))
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ role: 'assistant', content: '' }))

      // A request without tools (a title, a summary) is not part of the turn: a plain answer, the script stays where it is.
      // Hermes defers plugin tools behind its tool search by default: `os_ui` is then reached through `tool_call`, as a real model does.
      const direct = tools.includes('os_ui')
      const call = direct || tools.includes('tool_call') ? script[step] : undefined

      if (call) {
        step++
        const [name, args] = direct ? [call.name, call.args] : ['tool_call', { calls: [{ name: call.name, arguments: call.args }] }]
        res.write(chunk({ tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }))
        res.write(chunk({}, 'tool_calls'))
      } else {
        if (tools.length && step === script.length) doneServed = true
        res.write(chunk({ content: tools.length ? DONE : 'Titre' }))
        res.write(chunk({}, 'stop'))
      }

      res.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()))
  const url = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
  const root = fs.mkdtempSync(path.join(tmpdir(), ROOT_PREFIX))
  const home = path.join(root, 'hermes')

  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(home, 'config.yaml'),
    ['model:', '  provider: custom', `  base_url: ${url}`, '  default: fake-model', 'agent:', '  api_max_retries: 0', 'fallback_providers: []', 'updates:', '  check: false', 'auxiliary:', '  title_generation:', '    enabled: false', ''].join('\n')
  )
  fs.writeFileSync(path.join(home, '.env'), 'OPENAI_API_KEY=sk-fake-e2e\n')

  const shell = await launchShell({ ...SHADOW, JAROD_OS_BACKEND: 'hermes', JAROD_OS_HERMES_ROOT: HERMES_ROOT }, { root, own: false, executablePath: PACKAGED })
  const { page } = shell
  let approvals: string[] = []
  let failure: unknown = null

  try {
    await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
    await answerApprovals(shell, ['mutate'])
    await expect(page.getByPlaceholder('Que voulez-vous accomplir ?').first()).toBeVisible({ timeout: 540_000 })
    await skipSetup(page)
    await page.getByRole('button', { name: 'Accueil' }).first().click()
    const composer = page.getByPlaceholder('Que voulez-vous accomplir ?').first()

    await composer.fill('Mets en pause puis supprime l’automatisation shadow-bench-absent')
    await composer.press('Enter')
    await expect.poll(() => doneServed, { timeout: 300_000 }).toBe(true)
    // The turn ends once that answer is in the conversation (in the DOM even when another page is on screen).
    await expect(page.getByText(DONE, { exact: true })).not.toHaveCount(0, { timeout: 60_000 })
    expect(step).toBe(script.length)
    expect(offered.some(tools => tools.includes('os_ui') || tools.includes('tool_call'))).toBe(true)
  } catch (error) {
    failure = error
  } finally {
    // What the turn did, before the app goes: the tools the model was offered, how far the script went, what the shell logged.
    approvals = await asked(shell).catch(() => [] as string[])
    const lines = await page.evaluate(() => window.jarodOS.backend.logTail(3000)).catch(() => [] as string[])
    console.log(`script step ${step}/${script.length}; requests ${offered.length}; tools offered: ${JSON.stringify([...new Set(offered.flat())].sort())}`)
    console.log(`tool results:\n${results.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}`)
    console.log(lines.filter(line => /os_ui|bridge|control|shadow|error|Error/i.test(line)).slice(-60).join('\n'))
    const { stats, divergences } = await quitAndRead(shell, 'hermes-bridge').finally(() => provider.close())

    await removeRoot(root)
    console.log(`native approvals asked: ${JSON.stringify(approvals)}`)
    if (failure) throw failure
    expect(divergences).toEqual([])
    expect(stats).toMatchObject({ diverged: 0, dropped: 0, stopReason: 'app quit' })
    expect(stats.byCommand['backend:ui']?.compared ?? 0).toBeGreaterThanOrEqual(4)
    expect(stats.byCommand['backend:ui-list']?.compared ?? 0).toBeGreaterThan(0)
    expect(stats.byCommand['backend:ui-state']?.compared ?? 0).toBeGreaterThan(0)
    // What those `ui` requests were worth, as the door decided: a read, an act, a mutate and a destructive command all went through.
    expect(Object.keys(stats.byCommand['backend:ui']?.tiers ?? {})).toEqual(expect.arrayContaining(['read', 'act', 'mutate', 'destructive']))
  }
})
