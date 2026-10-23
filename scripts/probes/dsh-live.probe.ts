/*
 * Banc « runtime réel » de l'adaptateur DSH : le `DshEngine` du cockpit (electron/engines/dsh.ts) conduit les DSH installés en ACP,
 * sur un DSH_HOME et un dossier de travail jetables, avec un faux fournisseur OpenAI sur 127.0.0.1 (aucun accès réseau).
 *   npx vitest run --config scripts/probes/vitest.live.config.ts dsh     (depuis la racine du dépôt)
 * Cibles : la CLI trouvée par `resolveDsh` (PATH) et le runtime embarqué par DSH NEXT, s'ils sont présents.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EngineEvent, EnginePermissionPolicy, EngineState } from '../../apps/desktop/shared/engines.ts'
import { DshEngine, type DshInstall, resolveDsh } from '../../apps/desktop/electron/engines/dsh.ts'

const WORK = process.env.JAROD_PROBE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-dsh-probe-'))

function fakeProvider(outside: string): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))

        return
      }

      const body = raw ? JSON.parse(raw) : {}
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
      const last = [...messages].reverse().find(m => m.role === 'user')
      const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      const toolSinceUser = messages.slice(messages.lastIndexOf(last as never)).some(m => m.role === 'tool')
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ role: 'assistant', content: '' }))
      const end = (finish: string) => {
        res.write(chunk({}, finish))
        res.end('data: [DONE]\n\n')
      }

      if (!body.tools?.length) {
        res.write(chunk({ content: 'Titre' }))

        return end('stop')
      }

      if (text.includes('OUTIL') && !toolSinceUser) {
        const pwsh = body.tools.find((t: { function?: { name?: string } }) => t.function?.name === 'pwsh')
        const modes: string[] = pwsh?.function?.parameters?.properties?.sandbox_permissions?.enum ?? []
        const args = { description: 'Écrire hors espace', command: `Set-Content -LiteralPath '${outside}' -Value x`, ...(modes.length ? { sandbox_permissions: modes[modes.length - 1], justification: 'Test d’accord.' } : {}) }
        res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'pwsh', arguments: JSON.stringify(args) } }] }))

        return end('tool_calls')
      }

      if (text.includes('LENT')) {
        for (let i = 0; i < 100 && !res.destroyed; i++) {
          await new Promise(resolve => setTimeout(resolve, 100))
          res.write(chunk({ content: 'xxxx' }))
        }

        return end('stop')
      }

      res.write(chunk({ content: text.includes('OUTIL') ? 'Outil traité.' : 'JAROD_DSH_TEST_OK' }))
      end('stop')
    })
  })

  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() })
    })
  )
}

function targets(): Array<[string, DshInstall]> {
  const list: Array<[string, DshInstall]> = []
  const onPath = resolveDsh()

  if (onPath) list.push([`${onPath.source} ${onPath.version}`, onPath])

  const next = resolveDsh({ env: { PATH: '', ProgramFiles: process.env.ProgramFiles, LOCALAPPDATA: process.env.LOCALAPPDATA } })

  if (next && next.bin !== onPath?.bin) list.push([`${next.source} ${next.version}`, next])

  return list
}

const until = async (check: () => boolean, ms: number, what: string) => {
  const start = Date.now()

  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`délai dépassé : ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe.each(targets())('DshEngine contre %s', (label, install) => {
  it('connexion, session, réponse, accord refusé, annulation, reprise, arrêt', async () => {
    const dir = path.join(WORK, label.replace(/[^\w.-]+/g, '_'))
    const outside = path.join(dir, 'hors-espace.txt')
    fs.mkdirSync(dir, { recursive: true })
    const provider = await fakeProvider(outside)
    const patch = path.join(dir, 'fake-provider.patch.yml')
    fs.writeFileSync(patch, ['- id: llm-pi-ai', '  config:', '    providers:', '      fakelocal:', '        apiKeyEnv: FAKE_LOCAL_KEY', '        api: openai-completions', `        baseURL: ${provider.url}`, '        models:', '          - id: fake-model', '- id: acp', '  config:', '    provider: fakelocal', '    model: fake-model', ''].join('\n'))
    const events: EngineEvent[] = []
    const states: EngineState[] = []
    let policy: EnginePermissionPolicy = 'ask'
    const make = () =>
      new DshEngine({
        resolve: () => install,
        home: path.join(dir, 'dsh-home'),
        workspace: path.join(dir, 'work'),
        policy: () => policy,
        internet: () => true,
        emit: event => events.push(event),
        onState: ({ state }) => states.push(state),
        log: line => console.log(`[dsh] ${line}`),
        extraArgs: ['--patch', patch],
        explicitEnv: () => ({ FAKE_LOCAL_KEY: 'sk-fake-local' })
      })
    let engine = make()
    const report: Record<string, unknown> = { cible: label }

    try {
      const t0 = Date.now()
      expect(await engine.start()).toEqual({ ok: true, value: undefined })
      report.connexion_ms = Date.now() - t0
      const session = await engine.newSession()
      expect(session.ok).toBe(true)
      const sessionId = (session as { value: string }).value

      let from = events.length
      engine.prompt(sessionId, 'Réponds uniquement : JAROD_DSH_TEST_OK')
      await until(() => events.slice(from).some(e => e.type === 'message.complete' || e.type === 'error'), 60_000, 'fin du premier tour')
      report.reponse = events.slice(from).filter(e => e.type === 'message.delta').map(e => e.payload.text).join('')
      report.evenements = events.slice(from).map(e => e.type)
      report.erreurs = events.slice(from).filter(e => e.type === 'error').map(e => e.payload.message)
      expect(report.reponse).toBe('JAROD_DSH_TEST_OK')

      from = events.length
      engine.prompt(sessionId, 'OUTIL : écris le fichier')
      await until(() => events.slice(from).some(e => e.type === 'approval.request'), 60_000, 'demande d’accord')
      const request = events.slice(from).find(e => e.type === 'approval.request')!
      report.accord = request.payload.title
      engine.respondApproval(String(request.payload.requestId), 'deny')
      await until(() => events.slice(from).some(e => e.type === 'message.complete'), 60_000, 'fin du tour outil')
      report.outil = events.slice(from).filter(e => e.type.startsWith('tool.')).map(e => `${e.type}:${e.payload.status}`)
      expect(fs.existsSync(outside)).toBe(false)

      from = events.length
      engine.prompt(sessionId, 'LENT : écris longtemps')
      await new Promise(resolve => setTimeout(resolve, 2000))
      const cancelAt = Date.now()
      engine.cancel(sessionId)
      await until(() => events.slice(from).some(e => e.type === 'message.complete'), 30_000, 'fin annulée')
      report.annulation = { stopReason: events.slice(from).find(e => e.type === 'message.complete')?.payload.stopReason, ms: Date.now() - cancelAt }
      expect(report.annulation).toMatchObject({ stopReason: 'cancelled' })

      await engine.stop()
      report.arret = engine.getState().state
      expect(engine.getState().state).toBe('stopped')

      // Redémarrage : la session revient de la persistance de DSH (son DSH_HOME), sans rejouer les anciens messages.
      engine = make()
      expect((await engine.start()).ok).toBe(true)
      const listed = await engine.listSessions()
      report.sessions_apres_redemarrage = listed.ok ? listed.value.map(s => s.sessionId) : listed.error
      expect(await engine.resumeSession(sessionId)).toEqual({ ok: true, value: undefined })
      from = events.length
      engine.prompt(sessionId, 'Encore')
      await until(() => events.slice(from).some(e => e.type === 'message.complete'), 60_000, 'tour après reprise')
      report.reprise = 'ok'
    } finally {
      await engine.stop()
      provider.close()
      console.log(`[probe] ${JSON.stringify(report)}`)
      fs.writeFileSync(path.join(dir, 'rapport.json'), JSON.stringify(report, null, 1))
    }
  }, 300_000)
})
