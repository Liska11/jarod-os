// Banc d'essai DeepSeek Harness (dsh) en ACP stdio, sur DSH_HOME jetable, faux fournisseur OpenAI local.
// Usage : node dsh_probe.mjs <bin.js de dsh> <dossier de travail>
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'

const [, , BIN, WORK] = process.argv
const HOME = path.join(WORK, 'home')
const PROJECT = path.join(WORK, 'project')
const OUTSIDE = path.join(WORK, 'hors-espace-escalade.txt')
fs.mkdirSync(HOME, { recursive: true })
fs.mkdirSync(PROJECT, { recursive: true })
const results = []
const record = (name, status, detail = '') => { results.push([name, status, detail]); console.log(`[${status}] ${name} ${detail}`) }

// ---------- faux fournisseur OpenAI Chat Completions ----------
const llmLog = []
const lastUser = msgs => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return typeof msgs[i].content === 'string' ? msgs[i].content : JSON.stringify(msgs[i].content); return '' }
const toolSinceUser = msgs => { for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'tool') return true; if (msgs[i].role === 'user') return false } return false }
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', async () => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] })); return }
    const body = raw ? JSON.parse(raw) : {}
    const msgs = body.messages ?? []
    const text = lastUser(msgs)
    const tools = body.tools ?? []
    llmLog.push({ main: tools.length > 0, text: text.slice(0, 60), auth: req.headers.authorization ? 'present' : 'absent' })
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const end = finish => { res.write(chunk({}, finish)); res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`); res.end('data: [DONE]\n\n') }
    const say = async (s, size = 6, delay = 0) => {
      res.write(chunk({ role: 'assistant', content: '' }))
      for (let i = 0; i < s.length; i += size) { if (res.destroyed) return; if (delay) await new Promise(r => setTimeout(r, delay)); res.write(chunk({ content: s.slice(i, i + size) })) }
      end('stop')
    }
    if (tools.length === 0) return say('Titre de test')
    if (text.includes('OUTIL')) {
      if (toolSinceUser(msgs)) return say('Outil traite, fin du tour.')
      const pwsh = tools.find(t => (t.function?.name ?? t.name) === 'pwsh')
      const modes = pwsh?.function?.parameters?.properties?.sandbox_permissions?.enum ?? []
      const args = { description: 'Ecrire un fichier hors espace', command: `Set-Content -LiteralPath '${OUTSIDE}' -Value x` }
      if (modes.length) Object.assign(args, { sandbox_permissions: modes[modes.length - 1], justification: 'Test de la demande d approbation.' })
      llmLog.push({ escalationModes: modes, toolNames: tools.map(t => t.function?.name ?? t.name) })
      res.write(chunk({ role: 'assistant', content: '' }))
      res.write(chunk({ tool_calls: [{ index: 0, id: 'call_probe_1', type: 'function', function: { name: 'pwsh', arguments: JSON.stringify(args) } }] }))
      return end('tool_calls')
    }
    if (text.includes('LENT')) return say('x'.repeat(400), 4, 100)
    return say('Bonjour depuis le faux modele local.')
  })
})
await new Promise(r => llm.listen(0, '127.0.0.1', r))
const LLM_PORT = llm.address().port
const PATCH = path.join(WORK, 'fake-provider.patch.yml')
fs.writeFileSync(PATCH, [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      fakelocal:',
  '        apiKeyEnv: FAKE_LOCAL_KEY',
  '        api: openai-completions',
  `        baseURL: http://127.0.0.1:${LLM_PORT}/v1`,
  '        models:',
  '          - id: fake-model',
  '- id: acp',
  '  config:',
  '    provider: fakelocal',
  '    model: fake-model',
  ''
].join('\n'))

// ---------- client ACP (JSON-RPC ligne par ligne sur stdio) ----------
function dshProcesses () {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-c', "Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'dsh.lib.bin\\.js|deepseek-ai.dsh' -and $_.CommandLine -notmatch 'Get-CimInstance' } | % { $_.ProcessId }"], { encoding: 'utf8' })
    return out.split(/\s+/).filter(Boolean).map(Number)
  } catch { return [] }
}

function startAgent () {
  const env = { ...process.env, DSH_HOME: HOME, FAKE_LOCAL_KEY: 'sk-fake-local', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost,::1' }
  for (const k of Object.keys(env)) if (/^(DEEPSEEK|OPENAI|ANTHROPIC|OPENROUTER|GEMINI|GOOGLE)_?.*(KEY|TOKEN)/i.test(k)) delete env[k]
  const child = spawn(process.execPath, [BIN, '--profile', 'acp', '--patch', PATCH], { cwd: PROJECT, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr = []
  child.stderr.on('data', d => stderr.push(String(d)))
  const pending = new Map()
  const updates = []
  const agentRequests = []
  let onAgentRequest = async () => ({ error: { code: -32601, message: 'not supported by probe' } })
  let nextId = 1
  const send = obj => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n')
  readline.createInterface({ input: child.stdout }).on('line', async line => {
    let msg
    try { msg = JSON.parse(line) } catch { updates.push({ nonJson: line.slice(0, 120) }); return }
    if (msg.method && msg.id !== undefined) {
      agentRequests.push(msg)
      const answer = await onAgentRequest(msg)
      send({ id: msg.id, ...answer })
    } else if (msg.method) {
      updates.push(msg)
    } else if (pending.has(msg.id)) {
      pending.get(msg.id)(msg); pending.delete(msg.id)
    }
  })
  const exited = new Promise(r => child.on('exit', (code, sig) => r({ code, sig })))
  return {
    child, stderr, updates, agentRequests, exited,
    setHandler: fn => { onAgentRequest = fn },
    call: (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
      const id = nextId++
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: pas de reponse en ${timeoutMs} ms`)) }, timeoutMs)
      pending.set(id, msg => { clearTimeout(t); resolve(msg) })
      send({ id, method, params })
    }),
    notify: (method, params) => send({ method, params })
  }
}

const chunksFor = (a, sid, from = 0) => a.updates.slice(from).filter(u => u.method === 'session/update' && u.params?.sessionId === sid && u.params?.update?.sessionUpdate === 'agent_message_chunk')
const textOf = chunks => chunks.map(c => c.params.update.content?.text ?? '').join('')

const before = dshProcesses()
let a = startAgent()
let sessionId
try {
  const init = await a.call('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const r = init.result ?? {}
  record('initialize', init.result ? 'OK' : 'ECHEC', `protocole=${r.protocolVersion} authMethods=${JSON.stringify(r.authMethods)} capacites=${JSON.stringify(r.agentCapabilities).slice(0, 220)}`)

  const created = await a.call('session/new', { cwd: PROJECT, mcpServers: [] })
  sessionId = created.result?.sessionId
  record('session/new', sessionId ? 'OK' : 'ECHEC', `${sessionId ?? JSON.stringify(created.error)} options=${JSON.stringify(created.result?.configOptions ?? created.result?.models ?? null).slice(0, 160)}`)

  let from = a.updates.length
  const p1 = await a.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Dis bonjour' }] })
  const c1 = chunksFor(a, sessionId, from)
  record('flux de reponse', p1.result && c1.length > 1 ? 'OK (par jetons)' : p1.result && c1.length === 1 ? 'PARTIEL (message valide entier)' : 'ECHEC', `${c1.length} morceaux, stop=${p1.result?.stopReason ?? JSON.stringify(p1.error)} texte=${JSON.stringify(textOf(c1))}`)

  from = a.updates.length
  a.setHandler(async msg => {
    if (msg.method === 'session/request_permission') {
      const reject = (msg.params.options ?? []).find(o => o.kind === 'reject_once') ?? (msg.params.options ?? []).find(o => String(o.kind).startsWith('reject'))
      return { result: reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } } }
    }
    return { error: { code: -32601, message: 'not supported by probe' } }
  })
  const p2 = await a.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'OUTIL : ecris le fichier' }] })
  const perm = a.agentRequests.find(m => m.method === 'session/request_permission')
  const toolUpdates = a.updates.slice(from).filter(u => ['tool_call', 'tool_call_update'].includes(u.params?.update?.sessionUpdate)).map(u => u.params.update.status ?? u.params.update.sessionUpdate)
  const esc = llmLog.find(l => l.escalationModes)
  record('outil factice -> approbation', perm ? 'OK' : 'AUCUNE DEMANDE', perm ? `options=${JSON.stringify(perm.params.options.map(o => o.kind))}` : `modes d'escalade annonces=${JSON.stringify(esc?.escalationModes)} outils=${JSON.stringify(esc?.toolNames)}`)
  record('refus respecte', fs.existsSync(OUTSIDE) ? 'ECHEC' : 'OK', `fichier hors espace ${fs.existsSync(OUTSIDE) ? 'CREE' : 'absent'} ; etats outil=${JSON.stringify(toolUpdates)} ; stop=${p2.result?.stopReason ?? JSON.stringify(p2.error)}`)

  from = a.updates.length
  const p3 = a.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'LENT : ecris longtemps' }] })
  const t0 = Date.now()
  // Le flux ACP ne livre que des messages valides : on annule pendant que le faux modele ecrit encore (~10 s au total).
  while (!llmLog.some(l => l.text?.includes('LENT')) && Date.now() - t0 < 60000) await new Promise(r => setTimeout(r, 100))
  await new Promise(r => setTimeout(r, 1500))
  const t1 = Date.now()
  a.notify('session/cancel', { sessionId })
  const r3 = await p3
  record('annulation', r3.result?.stopReason === 'cancelled' ? 'OK' : 'ECHEC', `stop=${r3.result?.stopReason ?? JSON.stringify(r3.error)} en ${Date.now() - t1} ms, ${chunksFor(a, sessionId, from).length} morceau(x) livre(s), texte partiel=${textOf(chunksFor(a, sessionId, from)).length} car.`)

  const bad = await a.call('session/prompt', { sessionId: 'inexistante', prompt: [{ type: 'text', text: 'x' }] }, 20000).catch(e => ({ error: { message: e.message } }))
  record('session inconnue refusee', bad.error ? 'OK' : 'ECHEC', JSON.stringify(bad.error ?? bad.result).slice(0, 140))
} finally {
  a.child.stdin.end()
  const ex = await Promise.race([a.exited, new Promise(r => setTimeout(() => r(null), 20000))])
  record('arret par fermeture de stdin', ex ? 'OK' : 'ECHEC', JSON.stringify(ex))
  if (!ex) a.child.kill()
}

a = startAgent()
try {
  const init = await a.call('initialize', { protocolVersion: 999, clientCapabilities: {} })
  record('version de protocole inconnue (999)', 'INFO', `reponse protocole=${init.result?.protocolVersion ?? JSON.stringify(init.error)}`)
  const list = await a.call('session/list', { cwd: PROJECT })
  const ids = (list.result?.sessions ?? []).map(s => s.sessionId)
  const res = await a.call('session/resume', { sessionId, cwd: PROJECT, mcpServers: [] })
  record('reprise apres redemarrage', ids.includes(sessionId) && res.result ? 'OK' : 'ECHEC', `listees=${JSON.stringify(ids)} resume=${res.result ? 'ok' : JSON.stringify(res.error)}`)
  const from = a.updates.length
  const p = await a.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Encore bonjour' }] })
  record('nouveau tour apres reprise', p.result ? 'OK' : 'ECHEC', `stop=${p.result?.stopReason} texte=${JSON.stringify(textOf(chunksFor(a, sessionId, from)))}`)
  const closed = await a.call('session/close', { sessionId })
  record('session/close', closed.result !== undefined ? 'OK' : 'ECHEC', JSON.stringify(closed.result ?? closed.error))
} finally {
  a.child.stdin.end()
  const ex = await Promise.race([a.exited, new Promise(r => setTimeout(() => r(null), 20000))])
  if (!ex) a.child.kill()
  fs.writeFileSync(path.join(WORK, 'stderr.log'), a.stderr.join(''))
}

llm.close()
const after = dshProcesses()
record('processus dsh externes intacts', before.every(p => after.includes(p)) && after.every(p => before.includes(p)) ? 'OK' : 'A VERIFIER', `avant=${JSON.stringify(before)} apres=${JSON.stringify(after)}`)
console.log('requetes au faux LLM :', llmLog.filter(l => 'main' in l).length, 'auth', JSON.stringify([...new Set(llmLog.map(l => l.auth).filter(Boolean))]))
fs.writeFileSync(path.join(WORK, 'resultats.json'), JSON.stringify(results, null, 1))
