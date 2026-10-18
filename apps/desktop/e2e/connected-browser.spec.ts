import { expect, test, type Page } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { browserCall, isDescendantOf, killTree, processesUsing, say, startFakeModel, startSite, type FakeModel, type Site } from './e2-support'
import { type Launched, launchShell } from './launch'

/*
 * E2 (connected browser) on the BUILT app: the real Electron shell, the real bundled core, the real engine and a throwaway Chrome, against a scripted
 * model and a controlled site on this machine. Nothing here opens the user's own browser or profile: the profile is the one the app makes itself
 * (jarod-e2-* under the temp folder) and every data folder of the app lives in a fresh temp directory.
 *
 * Run `npm run bundle:core && npm run build` first. The shell runs in French here: assertions use the labels of src/locales/fr.ts.
 */
test.describe.configure({ mode: 'serial' })

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const HAS_ENGINE = process.platform === 'win32' && existsSync(path.join(ROOT, 'engines', 'browser-harness', 'Scripts', 'python.exe'))
const KEY = ['sk', 'CANARI-E2E-0123456789abcdef0123456'].join('-')
const GROUP = 'Navigateur connecté'
const SWITCH = 'Permettre à l’agent de demander des actions dans un navigateur'
const ALLOW_LABEL = 'Domaines permis au navigateur'

let shell: Launched
let page: Page
let model: FakeModel
let site: Site
/** The browser profile the app made for the session under test (its own folder under the temp folder). */
let liveProfile = ''
let wsInfo: { wsUrl?: string; wsToken?: string }

interface Control {
  call: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  close: () => void
}

/**
 * The test's own line to the gateway (not the window's): used to set the model up and to read the settings back, never to approve anything. It is opened
 * for one call and closed at once: the gateway asks the most recent connection for native gestures (confirmations), which must stay the window's.
 */
async function connectControl(state: { wsUrl?: string; wsToken?: string }): Promise<Control> {
  const ws = new WebSocket(`${state.wsUrl}?token=${state.wsToken}`)
  const waiting = new Map<number, (frame: { result?: unknown; error?: { message?: string } }) => void>()
  let id = 0

  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } }

    if (typeof frame.id === 'number') {
      waiting.get(frame.id)?.(frame)
    }
  })
  await new Promise<void>((ok, bad) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => bad(new Error('control line refused')))
  })

  const call = <T,>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((ok, bad) => {
      const n = ++id

      waiting.set(n, frame => (frame.error ? bad(new Error(frame.error.message ?? 'error')) : ok(frame.result as T)))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))
    })

  return { call, invoke: async <T,>(channel: string, ...args: unknown[]) => (await call<{ result: T }>('jarod.invoke', { channel, args })).result, close: () => ws.close() }
}

/** The temp folders the app made for browser sessions (one per live session). */
const sessionDirs = () =>
  readdirSync(tmpdir()).filter(name => {
    if (!name.startsWith('jarod-e2-')) {
      return false
    }

    try {
      // only the sessions of THIS app: the owner recorded in the folder's marker is the gateway, a descendant of the Electron process we launched
      const { ownerPid } = JSON.parse(readFileSync(path.join(tmpdir(), name, 'owner.json'), 'utf8')) as { ownerPid: number }

      return isDescendantOf(ownerPid, shell.app.process().pid ?? -1)
    } catch {
      return false
    }
  })
async function withControl<T>(run: (c: Control) => Promise<T>): Promise<T> {
  const c = await connectControl(wsInfo)

  try {
    return await run(c)
  } finally {
    c.close()
    await new Promise(r => setTimeout(r, 300))
  }
}

const setting = () => withControl(async c => (await c.invoke<{ connectedBrowser: { enabled: boolean; allowDomains: string[]; denyDomains: string[] } }>('get-jarod-settings')).connectedBrowser)

/** Replaces the native confirmation dialog in the main process: records what it says and answers like the user would. */
async function stubDialogs() {
  await shell.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __dialogs: { message: string; detail: string; buttons: string[] }[]; __answer: number }

    g.__dialogs = []
    g.__answer = 0
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string; detail?: string; buttons: string[] }

      g.__dialogs.push({ message: options.message, detail: options.detail ?? '', buttons: options.buttons })

      return { response: g.__answer, checkboxChecked: false }
    }) as never
  })
}

const answerDialogs = (response: 0 | 1) => shell.app.evaluate((_electron, r) => void ((globalThis as unknown as { __answer: number }).__answer = r), response)
const dialogs = () => shell.app.evaluate(() => (globalThis as unknown as { __dialogs: { message: string; detail: string; buttons: string[] }[] }).__dialogs)

async function openAgentSettings() {
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Agent et sécurité', exact: true }).click()
  await expect(page.getByRole('heading', { name: GROUP })).toBeVisible({ timeout: 30_000 })
}

/** Types a domain into the « allowed domains » list of the connected-browser group and presses its own Add button (the other lists have theirs). */
async function addAllowedDomain(domain: string) {
  const form = page.locator('form').filter({ has: page.getByLabel(`Ajouter à ${ALLOW_LABEL}`) })

  await form.getByLabel(`Ajouter à ${ALLOW_LABEL}`).fill(domain)
  await form.getByRole('button', { name: 'Ajouter', exact: true }).click()
}

/** One chat turn: the scripted model calls the tool with `args` (or not), then concludes. The window shows the approval card; `decision` clicks it. */
async function ask(args: Record<string, unknown> | null, decision?: 'once' | 'deny') {
  const seen = model.offered.length

  model.queue.push(...(args ? [browserCall(args), say('done')] : [say('done')]))
  await page.getByRole('button', { name: 'Accueil' }).click()

  const composer = page.getByPlaceholder('Que voulez-vous accomplir ?').first()

  await composer.fill(`go ${Date.now()}`)
  await composer.press('Enter')

  if (decision) {
    // the approval card: the block that holds the « Autoriser une fois » button, with the description and the command the engine showed
    const once = page.getByRole('button', { name: 'Autoriser une fois', exact: true })
    const card = page.locator('div.flex.flex-col.gap-3').filter({ has: once }).last()

    await expect(once).toBeVisible({ timeout: 60_000 })

    const description = await card.innerText()

    await page.getByRole('button', { name: decision === 'once' ? 'Autoriser une fois' : 'Refuser', exact: true }).click()

    return { description, seen }
  }

  await expect.poll(() => model.offered.length, { timeout: 60_000 }).toBeGreaterThan(seen)

  return { description: '', seen }
}

/** Every tool the model was offered since request number `seen` (always non-empty when a turn ran: the control that makes « not offered » mean something). */
const offeredSince = (seen: number) => {
  const names = model.offered.slice(seen).flat()

  expect(names.length, 'the model was offered a tool list').toBeGreaterThan(0)

  return names
}

test.skip(!HAS_ENGINE, 'the pinned engine (engines/browser-harness) is not installed')

test.beforeAll(async () => {
  model = await startFakeModel()
  site = await startSite()
  shell = await launchShell({ JAROD_E2_ENGINE_ROOT: ROOT, JAROD_CUSTOM_API_KEY: KEY })
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' })).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) {
      break
    }

    await next.first().click()
    await page.waitForTimeout(600)
  }

  wsInfo = await page.evaluate(() => window.heraldOS.backend.getState())
  await withControl(async c => {
    await c.invoke('add-model', 'e2e', 'custom', 'jarod-test-model', `http://127.0.0.1:${model.port}/v1`)
    await c.call('config.set', { key: 'model', value: 'custom:jarod-test-model' })
    await c.invoke('set-jarod-settings', { toolSearch: 'off', autoTitle: false })
  })
  await stubDialogs()
})

test.afterAll(async () => {
  await shell?.close()
  await site?.close()
  await model?.close()
})

test('OFF by default: the setting is off and empty, and the model is offered no connected-browser tool; no browser, no profile', async () => {
  const before = sessionDirs()

  expect(await setting()).toEqual({ enabled: false, allowDomains: [], denyDomains: [] })
  const { seen } = await ask(null)

  expect(offeredSince(seen)).not.toContain('connected_browser')
  expect(sessionDirs()).toEqual(before)
})

test('enabling then CANCELLING the confirmation leaves the setting unchanged', async () => {
  await openAgentSettings()
  await answerDialogs(1) // Cancel

  const toggle = page.getByRole('switch', { name: SWITCH })

  await toggle.click()
  await expect.poll(async () => (await dialogs()).length, { timeout: 15_000 }).toBeGreaterThan(0)
  expect((await dialogs()).at(-1)).toMatchObject({ message: 'Activer ou élargir le navigateur connecté ?', buttons: ['Autoriser ces domaines', 'Cancel'] })
  await page.waitForTimeout(800)
  expect(await setting()).toMatchObject({ enabled: false, allowDomains: [] })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
})

test('enabling WITHOUT a domain: no tool is offered and no session exists', async () => {
  await openAgentSettings()
  await answerDialogs(0) // the user accepts
  await page.getByRole('switch', { name: SWITCH }).click()
  await expect.poll(async () => (await setting()).enabled, { timeout: 15_000 }).toBe(true)
  expect((await dialogs()).at(-1)!.detail).toContain('le navigateur connecté est activé')

  const before = sessionDirs()

  const { seen } = await ask(null)

  expect(offeredSince(seen)).not.toContain('connected_browser')
  expect(sessionDirs()).toEqual(before)
})

test('adding a domain: the tool appears WITHOUT a restart, and still no browser is started', async () => {
  await openAgentSettings()
  await answerDialogs(0)
  await addAllowedDomain('site.localhost')
  await expect.poll(async () => (await setting()).allowDomains, { timeout: 15_000 }).toEqual(['site.localhost'])
  expect((await dialogs()).at(-1)!.detail).toContain('site.localhost')
  // a second domain, so that withdrawing the first later leaves the tool in place and only the SESSION is revoked
  await addAllowedDomain('autre.example.org')
  await expect.poll(async () => (await setting()).allowDomains, { timeout: 15_000 }).toEqual(['site.localhost', 'autre.example.org'])

  const before = sessionDirs()

  const { seen } = await ask(null)

  expect(offeredSince(seen)).toContain('connected_browser')
  await page.waitForTimeout(1500)
  expect(sessionDirs()).toEqual(before) // nothing launched at start-up, nor by the setting itself
})

test('a REFUSED action: the card names the exact target; nothing is launched and the site is never reached', async () => {
  const before = sessionDirs()
  const hits = site.hits.length
  const { description } = await ask({ op: 'open_tab', url: site.url('/second') }, 'deny')

  expect(description).toContain('site.localhost')
  expect(description).toContain('/second')
  await expect.poll(() => model.queue.length, { timeout: 60_000 }).toBe(0)
  await page.waitForTimeout(1500)
  expect(sessionDirs()).toEqual(before)
  expect(site.hits.length).toBe(hits)
})

test('an APPROVED action launches the throwaway profile and performs exactly the action presented', async () => {
  const before = sessionDirs()
  const hits = site.hits.length
  const { description } = await ask({ op: 'open_tab', url: site.url('/second') }, 'once')

  expect(description).toContain('/second')
  await expect.poll(() => sessionDirs().filter(d => !before.includes(d)).length, { timeout: 90_000 }).toBe(1)

  const profile = path.join(tmpdir(), sessionDirs().find(d => !before.includes(d))!)

  liveProfile = profile
  await expect.poll(() => site.hits.slice(hits).some(h => h.path === '/second' && h.host === 'site.localhost'), { timeout: 60_000 }).toBe(true)
  expect(site.hits.slice(hits).filter(h => h.path !== '/second' && h.path !== '/favicon.ico')).toEqual([])
  expect(processesUsing(profile)).toBeGreaterThan(0)
  // the profile belongs to the app (its own marker), under the temp folder, and is not any browser profile of the user
  expect(JSON.parse(readFileSync(path.join(profile, 'owner.json'), 'utf8'))).toMatchObject({ chromePid: expect.any(Number) })
  expect(profile.startsWith(tmpdir())).toBe(true)
})

test('REVOKING a domain DURING an operation: the operation is cut, the page stops sending in the background, the session and its profile are gone', async () => {
  const profile = liveProfile

  expect(profile).not.toBe('')
  // an open page that keeps sending requests by itself, then a slow navigation in progress
  model.queue.length = 0
  await ask({ op: 'open_tab', url: site.url('/ticker') }, 'once')
  await expect.poll(() => site.hits.filter(h => h.path === '/tick').length, { timeout: 60_000 }).toBeGreaterThan(5)

  const ticks = () => site.hits.filter(h => h.path === '/tick' || h.path === '/tickimg').length

  // a navigation that takes longer than the test: the operation is still running when the domain is withdrawn
  const slowStarted = site.hits.filter(h => h.path === '/slow').length
  const requestsBeforeSlow = model.offered.length

  await ask({ op: 'open_tab', url: site.url('/slow?ms=60000') }, 'once')
  await expect.poll(() => site.hits.filter(h => h.path === '/slow').length, { timeout: 60_000 }).toBeGreaterThan(slowStarted)
  expect(model.offered.length).toBe(requestsBeforeSlow + 1) // the model is still waiting for the tool: the operation is in flight

  const slowAt = Date.now()

  expect(existsSync(profile)).toBe(true)
  // revoke: remove the domain from the window (hardening: no confirmation)
  await openAgentSettings()
  await page.getByRole('button', { name: `Retirer site.localhost de ${ALLOW_LABEL}`, exact: true }).click()
  await expect.poll(async () => (await setting()).allowDomains, { timeout: 15_000 }).toEqual(['autre.example.org'])
  await expect.poll(() => existsSync(profile), { timeout: 30_000 }).toBe(false)
  // the operation that was in flight is CUT (the model gets its answer back), not left to run out its own time
  await expect.poll(() => model.offered.length, { timeout: 20_000 }).toBe(requestsBeforeSlow + 2)
  // the engine alone would give up on this page after 10 s: an answer sooner than that was the revocation, not the timeout
  expect(Date.now() - slowAt).toBeLessThan(8000)

  const atRevoke = ticks()

  await page.waitForTimeout(1500)
  expect(ticks()).toBe(atRevoke) // not one background request after the revocation
  expect(processesUsing(profile)).toBe(0)
  // a domain is left: the tool stays offered, but the session that served the withdrawn domain is gone
  const { seen } = await ask(null)

  expect(offeredSince(seen)).toContain('connected_browser')
})

test('LOSING the guard (browser killed from outside): operations are refused without asking, the session is stopped, the next approved action starts a new one', async () => {
  await openAgentSettings()
  await answerDialogs(0)
  await addAllowedDomain('site.localhost')
  await expect.poll(async () => (await setting()).allowDomains, { timeout: 15_000 }).toEqual(['autre.example.org', 'site.localhost'])

  const before = sessionDirs()

  await ask({ op: 'open_tab', url: site.url('/') }, 'once')
  await expect.poll(() => sessionDirs().filter(d => !before.includes(d)).length, { timeout: 90_000 }).toBe(1)

  const profile = path.join(tmpdir(), sessionDirs().find(d => !before.includes(d))!)

  liveProfile = profile

  const marker = JSON.parse(readFileSync(path.join(profile, 'owner.json'), 'utf8')) as { chromePid: number }

  killTree(marker.chromePid)
  await expect.poll(() => existsSync(profile), { timeout: 60_000 }).toBe(false) // stopped by itself

  // the next operation on the lost tab is refused BEFORE any approval is asked
  const seen = model.offered.length

  model.queue.push(browserCall({ op: 'read_page', tab: 'A'.repeat(32) }), say('done'))
  await page.getByRole('button', { name: 'Accueil' }).click()

  const composer = page.getByPlaceholder('Que voulez-vous accomplir ?').first()

  await composer.fill('read it')
  await composer.press('Enter')
  await expect.poll(() => model.offered.length, { timeout: 60_000 }).toBeGreaterThan(seen + 1)
  await expect(page.getByRole('button', { name: 'Autoriser une fois', exact: true })).toHaveCount(0)

  // a new approved action: a fresh profile, a fresh guard
  const again = sessionDirs()

  await ask({ op: 'open_tab', url: site.url('/second') }, 'once')
  await expect.poll(() => sessionDirs().filter(d => !again.includes(d)).length, { timeout: 90_000 }).toBe(1)
  liveProfile = path.join(tmpdir(), sessionDirs().find(d => !again.includes(d))!)
})

test('SWITCHING OFF: the session is closed at once and the tool disappears; nothing of ours is left running', async () => {
  const live = liveProfile

  expect(existsSync(live)).toBe(true)
  await openAgentSettings()
  await page.getByRole('switch', { name: SWITCH }).click() // hardening: no confirmation
  await expect.poll(async () => (await setting()).enabled, { timeout: 15_000 }).toBe(false)
  await expect.poll(() => existsSync(live), { timeout: 30_000 }).toBe(false)
  expect(processesUsing(live)).toBe(0)
  const { seen } = await ask(null)

  expect(offeredSince(seen)).not.toContain('connected_browser')
})
