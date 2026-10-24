// V-16 — banc d'essai : Hermes parle-t-il ACP de bout en bout ? À lancer HORS de tout bac à sable (le serveur ACP de Hermes démarre sa
// passerelle hors du « job » Windows courant ; un bac qui l'interdit répond `windows_breakaway_unavailable`).
//
// Usage (depuis la racine du dépôt, dans un terminal ordinaire) :
//   node scripts/probes/hermes-acp-probe.mjs [chemin de hermes-acp(.exe)]
// Par défaut : %LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes-acp.exe.
//
// Rien de réel n'est touché : HERMES_HOME est un dossier jetable (supprimé à la fin), le modèle est un faux fournisseur OpenAI local
// (127.0.0.1, port libre) qui répond « pong-acp ». Étapes : initialize → session/new → session/prompt (le texte du faux modèle doit
// revenir par session/update) → arrêt. Code de sortie 0 = tout est passé ; 1 = une étape a échoué (elle est nommée).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const EXE = process.argv[2] ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes-acp.exe')
const STEP_MS = 120_000
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[${ok ? 'OK' : 'ÉCHEC'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

if (!fs.existsSync(EXE)) {
  console.error(`hermes-acp introuvable : ${EXE}`)
  process.exit(2)
}

// ---------- faux fournisseur OpenAI (Chat Completions, flux SSE) ----------
const seen = []
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => (raw += c))
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }))
      return
    }
    seen.push(req.url)
    const body = raw ? JSON.parse(raw) : {}
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content: 'pong-acp' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(chunk({ role: 'assistant', content: '' }))
    res.write(chunk({ content: 'pong-acp' }))
    res.write(chunk({}, 'stop'))
    res.end('data: [DONE]\n\n')
  })
})
await new Promise(r => llm.listen(0, '127.0.0.1', r))
const port = llm.address().port

// ---------- HERMES_HOME jetable ----------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-hermes-acp-'))
const work = path.join(home, 'work')
fs.mkdirSync(work)
fs.writeFileSync(path.join(home, 'config.yaml'), `model:\n  default: "fake-model"\n  provider: "custom"\n  base_url: "http://127.0.0.1:${port}/v1"\n  api_key: "fake-key"\n`)

// ---------- client ACP minimal (JSON-RPC sur stdio, une ligne par message) ----------
const child = spawn(EXE, [], { cwd: work, env: { ...process.env, HERMES_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buffer = ''
let stderr = ''
const replies = new Map()
const updates = []
child.stderr.on('data', d => (stderr += d))
child.stdout.on('data', d => {
  buffer += d
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.method === 'session/update') updates.push(m.params)
    else if (m.method === 'session/request_permission' && m.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'cancelled' } } })}\n`)
    else if (m.id !== undefined && m.method === undefined) replies.set(m.id, m)
  }
})
let nextId = 1
const call = async (method, params) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  const end = Date.now() + STEP_MS
  while (Date.now() < end) {
    if (replies.has(id)) return replies.get(id)
    await new Promise(r => setTimeout(r, 50))
  }
  return { error: { message: `pas de réponse en ${STEP_MS / 1000} s` } }
}

try {
  const init = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  record('initialize', Boolean(init.result), init.result ? `${init.result.agentInfo?.name ?? '?'} ${init.result.agentInfo?.version ?? ''}` : JSON.stringify(init.error))
  if (init.result) {
    const created = await call('session/new', { cwd: work, mcpServers: [] })
    const sessionId = created.result?.sessionId
    record('session/new', Boolean(sessionId), sessionId ? `session ${sessionId}` : JSON.stringify(created.error))
    if (sessionId) {
      const answered = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Réponds exactement : pong-acp' }] })
      const text = updates
        .filter(u => u?.update?.sessionUpdate === 'agent_message_chunk')
        .map(u => u.update.content?.text ?? '')
        .join('')
      record('session/prompt', Boolean(answered.result), answered.result ? `stopReason ${answered.result.stopReason}` : JSON.stringify(answered.error))
      record('réponse du modèle reçue par session/update', text.includes('pong-acp'), `texte : ${JSON.stringify(text.slice(0, 80))} ; requêtes au faux modèle : ${seen.length}`)
    }
  }
} finally {
  child.stdin.end()
  child.kill()
  await new Promise(r => setTimeout(r, 1500))
  // Hermes détache sa passerelle (`gateway run --idle-exit`) : elle survit au serveur ACP (constaté encore en vie 5 min après). On
  // n'arrête que CELLE de ce dossier jetable — son fichier d'état nomme le dossier — jamais la passerelle de la vraie installation.
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'gateway_state.json'), 'utf8'))
    if (state.kind === 'hermes-gateway' && path.resolve(state.hermes_home) === path.resolve(home) && Number.isInteger(state.pid)) {
      process.kill(state.pid)
      console.log(`(passerelle du dossier jetable arrêtée : pid ${state.pid})`)
      await new Promise(r => setTimeout(r, 1500))
    }
  } catch {
    // Pas de passerelle lancée, ou déjà partie.
  }
  llm.close()
  try {
    fs.rmSync(home, { recursive: true, force: true })
  } catch {
    console.log(`(dossier jetable encore verrouillé, à supprimer à la main : ${home})`)
  }
}

const failed = results.filter(r => !r.ok)
if (failed.length) console.log(`\nDernières lignes d'erreur de Hermes :\n${stderr.trim().split('\n').slice(-8).join('\n')}`)
console.log(`\n${failed.length ? `ÉCHEC : ${failed.map(f => f.name).join(', ')}` : 'Tout est passé : Hermes parle ACP de bout en bout.'}`)
process.exit(failed.length ? 1 : 0)
