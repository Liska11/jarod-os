import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { type Launched, launchShell } from './launch'

// Réglages › Moteurs dans l'application réelle, profil jetable (docs/MULTI-RUNTIME-FAISABILITE.md) : la liste réelle des moteurs, puis DSH
// installé conduit depuis le cockpit en ACP — démarré, une session, une réponse, un accord refusé depuis la carte, une annulation.
// Le fournisseur est un faux serveur OpenAI sur 127.0.0.1 (aucun réseau) ; sa clé factice est rangée dans le DSH_HOME de Jarod
// (`.credentials.yaml`), comme le ferait la personne. Rien n'est lu ni écrit dans ~/.dsh.
test.describe.configure({ mode: 'serial' })

let shell: Launched
let page: Page
let provider: http.Server
let providerUrl = ''
const outsideName = 'hors-espace-e2e.txt'

function startProvider(outside: string): Promise<void> {
  provider = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'fake-model', object: 'model' }]
          })
        )

        return
      }

      const body = raw ? JSON.parse(raw) : {}
      const messages = (body.messages ?? []) as Array<{
        role: string
        content: unknown
      }>
      const userAt = messages.map(m => m.role).lastIndexOf('user')
      const text = JSON.stringify(messages[userAt]?.content ?? '')
      const toolDone = messages.slice(userAt).some(m => m.role === 'tool')
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      const end = (finish: string) => {
        res.write(chunk({}, finish))
        res.end('data: [DONE]\n\n')
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ role: 'assistant', content: '' }))

      if (!body.tools?.length) {
        res.write(chunk({ content: 'Titre' }))

        return end('stop')
      }

      if (text.includes('OUTIL') && !toolDone) {
        const pwsh = body.tools.find((t: { function?: { name?: string } }) => t.function?.name === 'pwsh')
        const modes: string[] = pwsh?.function?.parameters?.properties?.sandbox_permissions?.enum ?? []
        const args = {
          description: 'Écrire hors espace',
          command: `Set-Content -LiteralPath '${outside}' -Value x`,
          ...(modes.length
            ? {
                sandbox_permissions: modes[modes.length - 1],
                justification: 'Test e2e.'
              }
            : {})
        }
        res.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'pwsh', arguments: JSON.stringify(args) }
              }
            ]
          })
        )

        return end('tool_calls')
      }

      if (text.includes('LENT')) {
        for (let i = 0; i < 150 && !res.destroyed; i++) {
          await new Promise(resolve => setTimeout(resolve, 100))
          res.write(chunk({ content: 'xxxx' }))
        }

        return end('stop')
      }

      res.write(
        chunk({
          content: text.includes('OUTIL') ? 'Outil traité.' : 'JAROD_DSH_TEST_OK'
        })
      )
      end('stop')
    })
  })

  return new Promise(resolve =>
    provider.listen(0, '127.0.0.1', () => {
      providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
      resolve()
    })
  )
}

const dshHome = () => path.join(shell.root, 'data', 'engines', 'dsh')
const dshRow = () => page.locator('[data-engine="dsh"]')

test.beforeAll(async () => {
  shell = await launchShell()
  page = shell.page
  await startProvider(path.join(shell.root, outsideName))
  await expect(page.getByRole('button', { name: 'Accueil' }).first()).toBeVisible({ timeout: 60_000 })

  for (let step = 0; step < 8; step++) {
    const next = page.getByRole('button', {
      name: /^(Plus tard|Suivant|Commencer)/
    })

    if (!(await next.count())) break
    await next.first().click()
    await page.waitForTimeout(800)
  }

  await page.getByRole('button', { name: 'Réglages' }).first().click()
  await page.getByRole('button', { name: 'Moteurs', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Moteurs de cette machine' })).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await shell?.close()
  provider?.close()
})

test('les trois moteurs, avec un état réel : installé n’est pas connecté', async () => {
  await expect(page.getByText('Noyau Jarod', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Hermes', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('DeepSeek Harness (DSH)', { exact: true }).first()).toBeVisible()
  // DSH n'est pas lancé tant que la personne ne le démarre pas.
  await expect(dshRow().getByText('détecté', { exact: true })).toBeVisible()
  await page.screenshot({
    path: path.join(test.info().outputDir, 'moteurs-liste.png'),
    fullPage: true
  })
})

test('DSH depuis le cockpit : démarrage, session, réponse', async () => {
  // Premier démarrage : DSH crée son profil `acp` dans le DSH_HOME de Jarod ; on l'arrête, on y range le fournisseur et la clé factices.
  await page.getByRole('button', { name: 'Démarrer' }).click()
  await expect(dshRow().getByText('connecté', { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await page.getByRole('button', { name: 'Arrêter' }).click()
  await expect(page.getByRole('button', { name: 'Démarrer' })).toBeVisible({
    timeout: 30_000
  })
  expect(fs.existsSync(path.join(dshHome(), 'profiles', 'acp'))).toBe(true)
  expect(fs.existsSync(path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'acp'))).toBe(false)
  fs.writeFileSync(
    path.join(dshHome(), 'profiles', 'acp', 'cordis.patch.yml'),
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      fakelocal:',
      '        apiKeyEnv: FAKE_LOCAL_KEY',
      '        api: openai-completions',
      `        baseURL: ${providerUrl}`,
      '        models:',
      '          - id: fake-model',
      '- id: acp',
      '  config:',
      '    provider: fakelocal',
      '    model: fake-model',
      ''
    ].join('\n')
  )
  fs.writeFileSync(path.join(dshHome(), '.credentials.yaml'), 'version: 1\nrefs:\n  FAKE_LOCAL_KEY: sk-fake-e2e\n')

  await page.getByRole('button', { name: 'Démarrer' }).click()
  await expect(dshRow().getByText('connecté', { exact: true })).toBeVisible({
    timeout: 60_000
  })
  await page.getByRole('button', { name: 'Nouvelle session' }).click()
  const box = page.getByRole('textbox', { name: 'Message à DSH' })
  await expect(box).toBeVisible({ timeout: 30_000 })
  await box.fill('Réponds uniquement : JAROD_DSH_TEST_OK')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByText('JAROD_DSH_TEST_OK', { exact: true })).toBeVisible({ timeout: 60_000 })
})

test('un accord demandé par DSH montre la commande ; le refus est respecté', async () => {
  const box = page.getByRole('textbox', { name: 'Message à DSH' })
  await expect(box).toBeEnabled({ timeout: 30_000 })
  await box.fill('OUTIL : écris le fichier')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByText('DSH demande à lancer pwsh :')).toBeVisible({
    timeout: 60_000
  })
  await expect(page.getByText(/command: Set-Content/)).toBeVisible()
  await page.screenshot({
    path: path.join(test.info().outputDir, 'moteurs-accord.png'),
    fullPage: true
  })
  await page.getByRole('button', { name: 'Refuser', exact: true }).click()
  await expect(page.getByText('pwsh : failed')).toBeVisible({
    timeout: 60_000
  })
  expect(fs.existsSync(path.join(shell.root, outsideName))).toBe(false)
})

test('Annuler arrête le tour en cours', async () => {
  const box = page.getByRole('textbox', { name: 'Message à DSH' })
  await expect(box).toBeEnabled({ timeout: 60_000 })
  await box.fill('LENT : écris longtemps')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: 'Annuler', exact: true }).click()
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(box).toBeEnabled()
  await page.getByRole('button', { name: 'Arrêter' }).click()
  await expect(page.getByRole('button', { name: 'Démarrer' })).toBeVisible({
    timeout: 30_000
  })
})
