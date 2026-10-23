/*
 * Banc « runtime réel » : Hermes lancé par le BackendManager de Jarod, dialogué par le client JSON-RPC du shell
 * (même fabrique de socket : `openGatewaySocket` et le `wsAuth` que donne le gestionnaire). Hors de la suite par défaut :
 *   npx vitest run --config scripts/probes/vitest.live.config.ts   (depuis la racine du dépôt)
 *
 * Profil : HERMES_HOME jetable (JAROD_PROBE_DIR), jamais celui des applications ouvertes. Environnement réduit à une liste
 * blanche avant le démarrage : le gestionnaire recopie `process.env`, le banc ne lui laisse donc que le nécessaire.
 *
 * JAROD_PROBE_MODE=fake (défaut) : faux fournisseur OpenAI sur 127.0.0.1, aucun accès réseau.
 * JAROD_PROBE_MODE=cloud : fournisseur et modèle lus dans le profil Hermes réel (lecture seule), clé passée par
 *   l'environnement du runtime sans être affichée ; un seul tour, aucun nouvel essai, sortie bornée. Exige l'accord
 *   explicite de la personne (JAROD_PROBE_CLOUD_OK=1) ; les garde-fous de coût sont vérifiés avant l'appel.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { JsonRpcGatewayClient, type GatewayEvent } from '@jarod-os/client'
import { describe, expect, it } from 'vitest'
import { openGatewaySocket } from '../../apps/desktop/src/lib/ws-auth.ts'
import { BackendManager } from '../../apps/desktop/electron/backend/manager.ts'

const MODE = process.env.JAROD_PROBE_MODE === 'cloud' ? 'cloud' : 'fake'
const WORK = process.env.JAROD_PROBE_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-hermes-probe-'))
const REAL_HOME = process.env.JAROD_PROBE_REAL_HERMES_HOME ?? path.join(process.env.LOCALAPPDATA ?? '', 'hermes')
const RUNTIME_ROOT = path.join(REAL_HOME, 'hermes-agent')
const KEEP = ['SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'PATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)']
const report: Record<string, unknown> = { mode: MODE }

function note(key: string, value: unknown): void {
  report[key] = value
  console.log(`[probe] ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/** Lit une variable du `.env` réel sans jamais la renvoyer ailleurs que dans l'environnement du runtime. */
function readEnvValue(file: string, name: string): string | undefined {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const values = lines.filter(line => line.startsWith(`${name}=`)).map(line => line.slice(name.length + 1).trim().replace(/^["']|["']$/g, ''))

  return values.reverse().find(Boolean)
}

/** Les trois lignes de modèle du profil réel (provider, default, base_url), lues sans charger le reste. */
function realModel(): { provider: string; model: string; baseUrl: string } {
  const text = fs.readFileSync(path.join(REAL_HOME, 'config.yaml'), 'utf8')
  const block = /^model:\r?\n((?:[ \t]+.*\r?\n)+)/m.exec(text)?.[1] ?? ''
  const field = (key: string) => new RegExp(`^  ${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''

  return { provider: field('provider'), model: field('default'), baseUrl: field('base_url') }
}

/** Un fournisseur nommé du profil réel (`providers.<nom>` : base_url, key_env, model), lu sans charger le reste ni lire la clé. */
function realProvider(name: string): { baseUrl: string; keyEnv: string; model: string } {
  const text = fs.readFileSync(path.join(REAL_HOME, 'config.yaml'), 'utf8')
  const block = new RegExp(`^  ${name}:\\r?\\n((?:    .*\\r?\\n)+)`, 'm').exec(text)?.[1] ?? ''
  const field = (key: string) => new RegExp(`^    ${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''

  return { baseUrl: field('base_url'), keyEnv: field('key_env'), model: field('model') }
}

function fakeProvider(): Promise<{ url: string; close: () => void; requests: number; seen: object[] }> {
  const state = { requests: 0, seen: [] as object[] }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))

        return
      }

      state.requests++
      const body = raw ? JSON.parse(raw) : {}
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>
      const excerpt = (m?: { content: unknown }) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')).slice(0, 120)
      state.seen.push({
        route: `${req.method} ${req.url}`,
        keys: Object.keys(body),
        stream: Boolean(body.stream),
        tools: (body.tools ?? []).length,
        max_tokens: body.max_tokens ?? body.max_completion_tokens ?? null,
        reasoning: body.reasoning ?? body.reasoning_effort ?? null,
        // Ce qui règle la pensée et la longueur selon les fournisseurs (NVIDIA NIM : chat_template_kwargs, nvext…).
        extras: Object.fromEntries(Object.entries(body).filter(([key]) => !['messages', 'tools', 'stream', 'model', 'stream_options'].includes(key))),
        messages: messages.length,
        prompt_chars: raw.length,
        system: excerpt(messages.find(m => m.role === 'system')),
        user: excerpt([...messages].reverse().find(m => m.role === 'user'))
      })
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ role: 'assistant', content: '' }))
      const text = body.tools ? 'JAROD_HERMES_TEST_OK' : 'Titre'

      for (let i = 0; i < text.length; i += 5) {
        res.write(chunk({ content: text.slice(i, i + 5) }))
      }

      res.write(chunk({}, 'stop'))
      res.end('data: [DONE]\n\n')
    })
  })

  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close(), get requests() { return state.requests }, seen: state.seen })
    })
  )
}

/** Plafond de coût accordé pour l'essai, en USD, et taille mesurée du tour en mode `fake` (corps de ~5 700 caractères). */
const MAX_COST_USD = 0.05
const PROMPT_TOKENS_ESTIMATE = 1_500
/** Sans `max_tokens` transmissible par la passerelle, la sortie est bornée par le seul budget : jetons de sortie couverts par le reste. */
/**
 * NVIDIA (catalogue d'API, integrate.api.nvidia.com) : le modèle doit figurer dans la liste publique. Le catalogue ne publie pas de prix
 * par jeton (accès développeur sur crédits) : rien à comparer au plafond, ce qui est dit dans le rapport plutôt que supposé gratuit.
 */
async function nvidiaGuards(baseUrl: string, modelId: string): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(15_000) })
  const ids = (((await response.json()) as { data?: Array<{ id: string }> }).data ?? []).map(m => m.id)
  note('catalogue_nvidia', { modeles: ids.length, present: ids.includes(modelId) })

  if (!ids.includes(modelId)) {
    throw new Error(`arrêt avant envoi : ${modelId} absent du catalogue NVIDIA`)
  }

  note('cout_estime', 'aucun prix par jeton publié par le catalogue NVIDIA (accès développeur sur crédits) ; aucune facturation en USD attendue')
}

async function cloudGuards(modelId: string): Promise<void> {
  // Catalogue public d'OpenRouter, sans identifiants ni inférence.
  const response = await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, { signal: AbortSignal.timeout(15_000) })
  const endpoints = ((await response.json()) as { data?: { endpoints?: Array<{ pricing?: { prompt?: string; completion?: string } }> } }).data?.endpoints ?? []
  note('points_acces', endpoints.length)

  if (endpoints.length === 0) {
    throw new Error(`arrêt avant envoi : ${modelId} n'a aucun point d'accès disponible chez OpenRouter`)
  }

  const prompt = Math.max(...endpoints.map(e => Number(e.pricing?.prompt ?? 0)))
  const completion = Math.max(...endpoints.map(e => Number(e.pricing?.completion ?? 0)))
  const inputCost = prompt * PROMPT_TOKENS_ESTIMATE
  note('cout_estime', { entree_usd: inputCost, sortie_usd_par_jeton: completion, sortie_couverte_par_le_plafond: completion > 0 ? Math.floor((MAX_COST_USD - inputCost) / completion) : 'illimitée (gratuit)' })

  // Pas de plafond de sortie dans ce chemin : un modèle payant n'est accepté que si 64 jetons de sortie ne mènent qu'à une fraction du plafond
  // ET qu'il faudrait une sortie démesurée (≥ 20 000 jetons) pour l'atteindre.
  if (completion > 0 && (inputCost + 64 * completion > MAX_COST_USD || (MAX_COST_USD - inputCost) / completion < 20_000)) {
    throw new Error('arrêt avant envoi : coût non maîtrisé sans plafond de sortie')
  }
}

/** Un profil Hermes minimal : modèle seul, aucun outil, aucun plugin, aucun MCP, aucune tâche, pas de titre ni d'auxiliaire. */
function writeMinimalHome(home: string, model: { provider: string; model: string; baseUrl: string }, extraEnv: Record<string, string>): void {
  fs.mkdirSync(home, { recursive: true })
  const yaml = [
    'model:',
    `  provider: ${model.provider}`,
    `  default: ${model.model}`,
    `  base_url: ${model.baseUrl}`,
    // Pas de plafond de sortie : la passerelle de Hermes ne transmet `max_tokens` qu'aux tâches auxiliaires (v0.22.4).
    'agent:',
    '  api_max_retries: 0',
    // Aucune relance après panne. La garde « réponse vide » ne descend pas sous UNE relance (v0.22.4) : seuil 0 = ce minimum,
    // et seulement si la réponse arrive vide ; `session.usage.calls` dit combien d'appels ont eu lieu.
    '  auto_recovery_cycles: 0',
    '  empty_response_guard:',
    '    cost_threshold_usd: 0',
    '  reasoning_effort: none',
    '  coding_context: "off"',
    'fallback_providers: []',
    // Liste vide enregistrée = zéro outil (agent_factory._load_enabled_toolsets) ; `toolsets` seul ne suffit pas.
    'platform_toolsets:',
    '  cli: []',
    'mcp_servers: {}',
    'plugins:',
    '  enabled: []',
    'hooks: {}',
    'cron:',
    '  enabled: false',
    'auxiliary:',
    '  title_generation:',
    '    enabled: false',
    'memory:',
    '  memory_enabled: false',
    '  user_profile_enabled: false',
    'updates:',
    '  check: false',
    'telemetry:',
    '  shared_metrics:',
    '    enabled: false',
    '    send: false',
    ''
  ].join('\n')
  fs.writeFileSync(path.join(home, 'config.yaml'), yaml)
  fs.writeFileSync(path.join(home, '.env'), Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
}

describe(`Hermes par le chemin Jarod (${MODE})`, () => {
  it('démarre, se connecte comme le shell et fait un tour', async () => {
    const hermesHome = path.join(WORK, 'hermes-home')
    let fake: Awaited<ReturnType<typeof fakeProvider>> | null = null
    let model: { provider: string; model: string; baseUrl: string }
    const runtimeEnv: Record<string, string> = {}

    if (MODE === 'cloud') {
      expect(process.env.JAROD_PROBE_CLOUD_OK, 'accord explicite requis').toBe('1')
      // Le fournisseur et sa clé viennent du profil réel ; un modèle désigné par la personne (JAROD_PROBE_MODEL) remplace le sien
      // dans le profil JETABLE seulement : le profil de Hermes Desktop n'est pas modifié.
      // JAROD_PROBE_PROVIDER désigne un fournisseur nommé du profil réel (`providers.nvidia`…) au lieu du fournisseur principal.
      const named = process.env.JAROD_PROBE_PROVIDER?.trim()
      let keyName: string

      if (named) {
        const p = realProvider(named)
        model = { provider: named, model: p.model, baseUrl: p.baseUrl }
        keyName = p.keyEnv
      } else {
        model = realModel()
        keyName = model.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : ''
      }

      if (process.env.JAROD_PROBE_MODEL?.trim()) {
        note('modele_configure_dans_hermes', model.model)
        model = { ...model, model: process.env.JAROD_PROBE_MODEL.trim() }
      }
      const key = keyName ? readEnvValue(path.join(REAL_HOME, '.env'), keyName) : undefined
      expect(key, `credential ${keyName} introuvable`).toBeTruthy()
      runtimeEnv[keyName] = key as string
      note('fournisseur', `${model.provider} (${model.baseUrl})`)
      note('modele', model.model)
      note('credential', `${keyName} présent (${(key as string).length} caractères, non affiché)`)
      await (model.provider === 'nvidia' ? nvidiaGuards(model.baseUrl, model.model) : cloudGuards(model.model))
    } else {
      fake = await fakeProvider()

      if (process.env.JAROD_PROBE_AS === 'nvidia') {
        // Répétition à blanc : Hermes croit parler à NVIDIA (mise en forme de sa requête comprise), le faux serveur la reçoit.
        model = { provider: 'nvidia', model: process.env.JAROD_PROBE_MODEL?.trim() || realProvider('nvidia').model, baseUrl: fake.url }
        Object.assign(runtimeEnv, { NVIDIA_API_KEY: 'nvapi-fake-probe', NVIDIA_BASE_URL: fake.url, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' })
      } else {
        model = { provider: 'custom', model: 'fake-model', baseUrl: fake.url }
        runtimeEnv.OPENAI_API_KEY = 'sk-fake-local'
      }
    }

    // Le profil n'écrit le credential que dans le profil jetable (supprimé à la fin), jamais dans les journaux.
    writeMinimalHome(hermesHome, model, MODE === 'cloud' ? {} : runtimeEnv)

    const saved = { ...process.env }

    for (const key of Object.keys(process.env)) {
      if (!KEEP.includes(key.toUpperCase())) {
        delete process.env[key]
      }
    }

    Object.assign(process.env, {
      HERMES_HOME: hermesHome,
      JAROD_OS_BACKEND: 'hermes',
      JAROD_OS_HERMES_ROOT: RUNTIME_ROOT,
      JAROD_OS_DEFAULT_CWD: WORK,
      HOME: WORK,
      USERPROFILE: WORK,
      ...(MODE === 'cloud' ? runtimeEnv : {})
    })

    // Electron définit toujours `process.resourcesPath` ; en développement, ce dossier ne porte pas le plugin pont, que
    // `ensureBridgePlugin` ne relie donc pas. Le banc reproduit ce cas : aucun plugin n'entre dans le profil jetable.
    const emptyResources = path.join(WORK, 'resources-sans-plugin')
    fs.mkdirSync(emptyResources, { recursive: true })
    Object.assign(process, { resourcesPath: emptyResources })
    const manager = new BackendManager({ packaged: false })
    const events: GatewayEvent[] = []
    let client: JsonRpcGatewayClient | null = null

    try {
      const t0 = Date.now()
      await manager.start()
      const state = manager.getState()
      note('backend', { phase: state.phase, runtime: state.runtime?.label, error: state.error })
      expect(state.phase).toBe('ready')
      note('demarrage_ms', Date.now() - t0)

      // Exactement la fabrique du shell (store/gateway.ts) : `openGatewaySocket` avec le `wsAuth` du gestionnaire.
      note('auth_ws', state.wsAuth ?? 'subprotocol (défaut)')
      client = new JsonRpcGatewayClient({
        requestIdPrefix: 'os',
        requestTimeoutMs: 180_000,
        socketFactory: url => openGatewaySocket(url, state.wsToken ?? null, state.wsAuth)
      })
      client.onAny(event => events.push(event))

      try {
        await client.connect(state.wsUrl as string)
        // Comme le canal du shell : annoncer les requêtes serveur (approbations).
        await client.request('client.capabilities', { server_requests: true }).catch(() => undefined)
        note('connexion_shell', 'ok')
      } catch (error) {
        note('connexion_shell', `refusée : ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }

      const created = await client.request<{ session_id: string; stored_session_id: string }>('session.create', { source: 'desktop', cwd: WORK, title: null })
      note('session', { vivante: created.session_id, stockee: created.stored_session_id })

      const sent = Date.now()
      let firstDelta = 0
      const done = new Promise<GatewayEvent>(resolve => {
        client!.onAny(event => {
          if (event.session_id !== created.session_id) {
            return
          }

          if (event.type === 'message.delta' && !firstDelta) {
            firstDelta = Date.now()
          }

          if (event.type === 'message.complete' || event.type === 'error') {
            resolve(event)
          }
        })
      })
      await client.request('prompt.submit', { session_id: created.session_id, text: 'Réponds uniquement : JAROD_HERMES_TEST_OK' })
      const final = await Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pas de fin de tour en 120 s')), 120_000))])
      const payload = (final.payload ?? {}) as Record<string, unknown>
      note('reponse', payload.text ?? payload)
      note('latence_ms', { premier_delta: firstDelta ? firstDelta - sent : null, fin: Date.now() - sent })
      const ofSession = events.filter(event => event.session_id === created.session_id)
      note('evenements', ofSession.map(event => event.type).filter((type, i, all) => type !== all[i - 1]))
      note('deltas', ofSession.filter(event => event.type === 'message.delta').length)

      try {
        note('usage', await client.request('session.usage', { session_id: created.session_id }))
      } catch (error) {
        note('usage', `indisponible : ${error instanceof Error ? error.message : String(error)}`)
      }

      if (fake) {
        note('requetes_fournisseur', fake.requests)
        note('detail_requetes', fake.seen)
      }
    } finally {
      client?.close()
      await manager.stop()
      note('arret', manager.getState().phase)
      process.env = saved
      fake?.close()
      fs.rmSync(path.join(hermesHome, '.env'), { force: true })
      fs.writeFileSync(path.join(WORK, `rapport-${MODE}.json`), JSON.stringify(report, null, 1))
    }
  }, 300_000)
})
