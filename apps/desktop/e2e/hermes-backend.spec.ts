import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Launched, launchShell, ROOT_PREFIX } from './launch'

// Le cockpit sur Hermes (JAROD_OS_BACKEND=hermes) dans l'application réelle : le Hermes installé, lancé par le gestionnaire de Jarod sur un
// HERMES_HOME jetable (jamais celui de Hermes Desktop), le shell relié à sa passerelle (jeton en `?token=`, ce que Hermes accepte en local),
// un message parti de l'Accueil et la réponse dans le chat. Le fournisseur est un faux serveur OpenAI sur 127.0.0.1 : aucun réseau.
// Ignoré quand Hermes n'est pas installé. Le premier démarrage prépare l'environnement Python propre à ce HERMES_HOME (plusieurs minutes).
test.describe.configure({ mode: 'serial' })

const runtimeRoot = path.join(process.env.LOCALAPPDATA ?? '', 'hermes', 'hermes-agent')
const installed = fs.existsSync(path.join(runtimeRoot, 'venv', 'Scripts', 'python.exe'))

let shell: Launched
let page: Page
let provider: http.Server
const seen: Array<{ path: string; tools: number }> = []

test.skip(!installed, 'Hermes Agent n’est pas installé sur cette machine')

test.beforeAll(async () => {
  test.setTimeout(720_000)
  provider = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/')) {
        res.writeHead(404).end()

        return
      }

      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))

        return
      }

      const body = raw ? JSON.parse(raw) : {}
      seen.push({ path: req.url, tools: (body.tools ?? []).length })
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ role: 'assistant', content: '' }))

      for (const part of ['JAROD_', 'HERMES_', 'TEST_OK']) {
        res.write(chunk({ content: part }))
      }

      res.write(chunk({}, 'stop'))
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

  shell = await launchShell({ JAROD_OS_BACKEND: 'hermes', JAROD_OS_HERMES_ROOT: runtimeRoot }, { root, own: true })
  page = shell.page
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })
  // L'écran de démarrage couvre le shell tant que le moteur n'est pas prêt ; la première fois, Hermes prépare l'environnement Python
  // de ce HERMES_HOME (un essai peut dépasser le délai du gestionnaire, qui relance).
  // Signal : le champ de l'Accueil, qui dit « Démarrage de Hermes… » jusqu'à ce que le moteur soit prêt.
  await expect(page.getByPlaceholder('Que voulez-vous accomplir ?').first()).toBeVisible({ timeout: 540_000 })

  // Le parcours d'accueil s'anime pendant que Hermes démarre (« Démarrage de Hermes ») : il ne fait pas partie de ce qu'on teste.
  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', { name: /^(Plus tard|Suivant|Commencer)/ })

    if (!(await next.count())) break
    await next.first().click({ timeout: 5_000, force: true }).catch(() => undefined)
    await page.waitForTimeout(800)
  }
})

test.afterAll(async () => {
  await shell?.close()
  provider?.close()
})

test('le cockpit sur Hermes : moteur prêt, message depuis l’Accueil, réponse dans le chat', async () => {
  test.setTimeout(600_000)
  // Le gestionnaire de Jarod lance Hermes ; « prêt » dans Réglages › Moteurs.
  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Moteurs', exact: true }).first().click()
  await expect(page.locator('[data-engine="hermes"][data-state="connected"]')).toBeVisible({ timeout: 480_000 })
  await expect(page.locator('[data-engine="hermes"]').getByText('cockpit', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(test.info().outputDir, 'moteurs-hermes-cockpit.png'), fullPage: true })

  await page.getByRole('button', { name: 'Accueil' }).first().click()
  const composer = page.getByPlaceholder('Que voulez-vous accomplir ?').first()
  await composer.fill('Réponds uniquement : JAROD_HERMES_TEST_OK')
  await composer.press('Enter')
  await expect(page.getByText('JAROD_HERMES_TEST_OK', { exact: true }).first()).toBeVisible({ timeout: 120_000 })
  await page.screenshot({ path: path.join(test.info().outputDir, 'chat-hermes.png'), fullPage: true })
  expect(seen.some(request => request.path.endsWith('/chat/completions'))).toBe(true)
})
