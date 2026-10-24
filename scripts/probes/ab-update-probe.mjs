// V-21 — validation réelle de la mise à jour A/B, sur l'appli EMPAQUETÉE (apps/desktop/release/win-unpacked, `npm run dist:win`).
//
//   node scripts/probes/ab-update-probe.mjs [--keep]
//
// Tout se passe dans un dossier jetable à côté de win-unpacked (même volume : les bundles sont des liens physiques), avec un profil isolé
// (HERMES_HOME, config, données, espace de travail, profil Electron) : rien du vrai Jarod-OS n'est touché, sa passerelle non plus. Les
// bundles sont signés avec une clé faite pour ce passage ; d'où les binaires de DÉBOGAGE de host-rust (`cargo build -p host-updater`), les
// seuls qui acceptent une clé de test. Étapes :
//   1. l'appli réelle 1.0.0 installée (premier emplacement, sans essai) ;
//   2. l'appli réelle 1.0.1 installée dans l'autre emplacement, à l'essai ;
//   3. démarrée PAR LE LANCEUR : l'appli doit valider elle-même son essai quand son noyau est prêt ;
//   4. une 1.0.2 qui plante au démarrage : le lanceur doit revenir à 1.0.1 et bloquer 1.0.2 ;
//   5. le lanceur redémarre bien 1.0.1, hors essai.
// Code de sortie 0 = tout est passé ; 1 = une étape a échoué (elle est nommée).
import { execFileSync, spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeBundle } from '../../apps/desktop/scripts/make-update-bundle.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = path.join(repo, 'apps', 'desktop', 'release', 'win-unpacked')
const debug = path.join(repo, 'host-rust', 'target', 'debug')
const updaterBin = path.join(debug, 'jarod-updater.exe')
const launcherBin = path.join(debug, 'jarod-launcher.exe')
const contracts = path.join(repo, 'contracts', 'v1')
const keep = process.argv.includes('--keep')
const CONFIRM_MS = 240_000

for (const [file, hint] of [
  [path.join(app, 'Jarod-OS.exe'), 'npm run dist:win (apps/desktop)'],
  [updaterBin, 'cargo build -p host-updater --bins (host-rust)'],
  [launcherBin, 'cargo build -p host-updater --bins (host-rust)']
]) {
  if (!existsSync(file)) {
    console.error(`introuvable : ${file} — ${hint}`)
    process.exit(2)
  }
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`[${ok ? 'OK' : 'ÉCHEC'}] ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const work = path.join(path.dirname(app), `ab-probe-${Date.now()}`)
const root = path.join(work, 'updates')
const profile = path.join(work, 'profile')
mkdirSync(profile, { recursive: true })

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const pub = path.join(work, 'test.pub')
const priv = path.join(work, 'test.key.pem')
writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }))
writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }))

const updater = (...args) => {
  try {
    return JSON.parse(execFileSync(updaterBin, [...args, '--root', root, '--contracts', contracts, '--test-key', pub], { encoding: 'utf8', windowsHide: true }).trim())
  } catch (error) {
    return JSON.parse(String(error.stdout || '{"ok":false,"error":"io"}').trim())
  }
}
const state = () => updater('status').state
const running = s => (s?.current ? s.slots[s.current] : null)

// The profile the app runs in: the e2e suite's isolation (e2e/launch.ts), nothing inherited that names Jarod's real folders.
const env = {}
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(JAROD_|ELECTRON_RUN_AS_NODE$)/.test(key)) env[key] = value
Object.assign(env, {
  HERMES_HOME: path.join(profile, 'hermes'),
  JAROD_OS_CONFIG_DIR: path.join(profile, 'config'),
  JAROD_OS_DATA: path.join(profile, 'data'),
  JAROD_WORKSPACE: path.join(profile, 'workspace'),
  JAROD_OS_ISOLATED: '1'
})

/** The launcher, as a shortcut would start it; returns the child and a promise of its exit code. */
function launch() {
  const child = spawn(launcherBin, ['--root', root, '--contracts', contracts, '--test-key', pub, '--', `--user-data-dir=${path.join(profile, 'user')}`], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: false
  })
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += chunk))
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  return { child, exited, stderr: () => stderr }
}

const killTree = pid => {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // Already gone.
  }
}

try {
  console.log(`dossier jetable : ${work}`)
  const b100 = await makeBundle({ from: app, version: '1.0.0', out: path.join(work, 'b100'), entry: 'Jarod-OS.exe', channel: 'stable', link: true, key: priv })
  console.log(`bundle de l'appli réelle : ${b100.files} fichiers, ${(b100.bytes / 1e6).toFixed(0)} Mo`)
  const first = updater('install', '--bundle', b100.out)
  record('1. appli réelle 1.0.0 installée, sans essai', first.ok && first.state.pending === null, first.ok ? `emplacement ${first.installed.slot}` : `${first.error}: ${first.detail}`)

  await makeBundle({ from: app, version: '1.0.1', out: path.join(work, 'b101'), entry: 'Jarod-OS.exe', channel: 'stable', link: true, key: priv })
  const second = updater('install', '--bundle', path.join(work, 'b101'))
  record('2. appli réelle 1.0.1 installée à l’essai', second.ok && second.state.pending?.slot === second.installed?.slot, second.ok ? `emplacement ${second.installed.slot}` : `${second.error}: ${second.detail}`)

  // 3. Started by the launcher: the real app must confirm its own trial when its core is ready.
  const run = launch()
  const started = Date.now()
  let confirmed = null
  while (Date.now() - started < CONFIRM_MS) {
    await sleep(2000)
    const s = state()
    if (s && s.pending === null && running(s)?.validated) {
      confirmed = s
      break
    }
    if (run.child.exitCode !== null) break
  }
  record(
    '3. lancée par le lanceur, l’appli réelle valide son essai (noyau prêt)',
    Boolean(confirmed) && running(confirmed)?.version === '1.0.1',
    confirmed ? `validée en ${Math.round((Date.now() - started) / 1000)} s` : `pas de validation (${run.child.exitCode === null ? 'toujours en cours' : `sortie ${run.child.exitCode}`}) ${run.stderr().slice(-300)}`
  )
  killTree(run.child.pid)
  await run.exited
  record('   l’arrêt de l’appli après validation ne déclenche aucun retour', running(state())?.version === '1.0.1' && state().blocked.length === 0)

  // 4. A version that crashes on start (its entry exits with an error at once).
  const bad = path.join(work, 'bad-src')
  mkdirSync(path.join(bad, 'bin'), { recursive: true })
  copyFileSync(path.join(process.env.SystemRoot, 'System32', 'where.exe'), path.join(bad, 'bin', 'fail.exe'))
  await makeBundle({ from: bad, version: '1.0.2', out: path.join(work, 'b102'), entry: 'bin/fail.exe', channel: 'stable', link: false, key: priv })
  const third = updater('install', '--bundle', path.join(work, 'b102'))
  const crash = launch()
  const code = await crash.exited
  const after = state()
  record('4. une 1.0.2 qui plante : retour à 1.0.1, 1.0.2 bloquée', third.ok && code !== 0 && running(after)?.version === '1.0.1' && after.blocked.includes('1.0.2'), `sortie ${code}`)

  // 5. The next start is the real 1.0.1, not on trial: still running after 25 s.
  const again = launch()
  await sleep(25_000)
  const log = readFileSync(path.join(root, 'launcher.log'), 'utf8')
  record('5. le lanceur redémarre l’appli réelle 1.0.1 hors essai', again.child.exitCode === null && /starting 1\.0\.1 from slot \w \(not on trial\)\s*$/m.test(log.trim().split('\n').at(-1) ?? ''))
  killTree(again.child.pid)
  await again.exited

  console.log(`\njournal du lanceur :\n${readFileSync(path.join(root, 'launcher.log'), 'utf8').trim()}`)
} finally {
  if (keep) console.log(`(dossier gardé : ${work})`)
  else {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(work, { recursive: true, force: true })
        break
      } catch {
        await sleep(2000)
      }
    }
    if (existsSync(work)) console.log(`(dossier jetable encore verrouillé, à supprimer à la main : ${work})`)
  }
}

const failed = results.filter(r => !r.ok)
console.log(`\n${failed.length ? `ÉCHEC : ${failed.map(f => f.name).join(' ; ')}` : 'Tout est passé : la mise à jour A/B marche sur l’appli empaquetée.'}`)
process.exit(failed.length ? 1 : 0)
