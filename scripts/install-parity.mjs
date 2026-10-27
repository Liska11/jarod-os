#!/usr/bin/env node
/**
 * install-parity.mjs — « installation == build de S: » (T01 et T03, portés du dépôt D:).
 *
 * T01 (check)   : l'application installée est ce que S: produit :
 *                 - le gateway du coeur (jarod-core/dist/gateway) === resources/jarod-core/gateway.mjs
 *                 - l'arbre dist/ de l'asar === apps/desktop/dist (les .map ne sont pas embarqués)
 *                 - le package.json de l'asar === apps/desktop/package.json moins scripts, devDependencies, build
 *                 - les empreintes enregistrées dans history/base-hashes.json (quand il existe)
 *
 * T03 (rebuild) : le build est reproductible, donc l'installation peut être rejouée depuis S: :
 *                 - deux `vite build` + bundle Electron donnent le même arbre que celui livré (dist/)
 *                 - deux bundle du gateway donnent le même fichier, identique à jarod-core/dist/gateway
 *                 - les fichiers du shell (dist/electron) sont identiques à ceux de l'asar installé
 *                 L'arbre est remis dans son état d'origine à la fin, quoi qu'il arrive.
 *                 Les *.map ne sont pas comparés : ils ne sont pas embarqués dans l'asar et dépendent
 *                 du cache du bundler, pas de l'installation.
 *
 * Usage : node scripts/install-parity.mjs check|rebuild|write|status [--json] [--install DIR]
 * Codes : 0 vert, 1 écart, 2 installation absente (SKIP).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const require = createRequire(import.meta.url)
const asar = require(path.join(REPO, 'node_modules', '@electron', 'asar'))

const args = process.argv.slice(2)
const cmd = args.find((a) => !a.startsWith('-')) || 'check'
const asJson = args.includes('--json')
const installArg = args.indexOf('--install')
const INSTALL_ROOT = installArg >= 0 ? args[installArg + 1] : process.env.JAROD_INSTALL_DIR || 'C:\\Program Files\\Jarod-OS'
const RES = path.join(INSTALL_ROOT, 'resources')
const INSTALLED_ASAR = path.join(RES, 'app.asar')
const INSTALLED_GW = path.join(RES, 'jarod-core', 'gateway.mjs')
const DESKTOP = path.join(REPO, 'apps', 'desktop')
const DIST = path.join(DESKTOP, 'dist')
const GW_FILE = path.join(REPO, 'jarod-core', 'dist', 'gateway', 'gateway.mjs')
const HASHES = path.join(REPO, 'history', 'base-hashes.json')

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const shaFile = (f) => sha(fs.readFileSync(f))
const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }

// Le build doit tourner comme un build, même lancé depuis la suite de tests.
const BUILD_ENV = { ...process.env, NODE_ENV: 'production' }
delete BUILD_ENV.VITEST
delete BUILD_ENV.VITEST_MODE
delete BUILD_ENV.TEST

function walk(dir, base = dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else out.push(path.relative(base, p).replace(/\\/g, '/'))
  }
  return out
}

/** Copie récursive (dossier -> dossier). */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const f of walk(from)) {
    const dest = path.join(to, f)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(from, f), dest)
  }
}

/** Les fichiers qui font l'installation : tout dist/ sauf les cartes sources. */
const shipped = (dir) => walk(dir).filter((f) => !f.endsWith('.map'))

/** Empreinte stable d'un arbre : chemin:sha256 de chaque fichier, dans l'ordre des chemins. */
function treeHash(dir, files = walk(dir)) {
  const lines = files.map((f) => `${f}:${shaFile(path.join(dir, f))}`)
  return sha(Buffer.from(lines.join('\n'), 'utf8'))
}

/** Les fichiers de l'asar, dossiers et entrées « unpacked » exclus. */
function asarFiles(asarPath) {
  const out = []
  for (const p of asar.listPackage(asarPath)) {
    const rel = p.replace(/^[\\/]+/, '').replace(/\\/g, '/')
    if (!rel || rel.endsWith('/')) continue
    let st
    try { st = asar.statFile(asarPath, rel.replace(/\//g, '\\')) } catch { continue }
    if (!st || st.files || st.unpacked) continue
    out.push(rel)
  }
  return out
}

/** Le package.json que electron-builder écrit dans l'asar : celui de l'app, sans scripts/devDependencies/build. */
function normalizedPackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'))
  for (const k of ['scripts', 'devDependencies', 'build']) delete pkg[k]
  return JSON.stringify(pkg, null, 2)
}

function installed() {
  return exists(INSTALLED_ASAR) && exists(INSTALLED_GW)
}

function check() {
  if (!installed()) {
    return { test: 'T01', status: 'SKIP', checks: [], detail: `Jarod-OS non installé dans ${INSTALL_ROOT}`, code: 2 }
  }
  const checks = []
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }) }

  const gwSrc = shaFile(GW_FILE)
  const gwInst = shaFile(INSTALLED_GW)
  add('gateway', gwSrc === gwInst, `${gwSrc.slice(0, 12)} (dist) / ${gwInst.slice(0, 12)} (installé)`)

  const distInAsar = asarFiles(INSTALLED_ASAR).filter((p) => p.startsWith('dist/'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-t01-'))
  let treeOk = false
  let treeDetail = ''
  try {
    for (const rel of distInAsar) {
      const dest = path.join(tmp, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, asar.extractFile(INSTALLED_ASAR, rel.replace(/\//g, '\\')))
    }
    // tout dist/ est comparé (y compris dist/electron, produit par esbuild) ; seuls les *.map ne sont pas embarqués
    const localFiles = shipped(DIST)
    const asarTree = treeHash(path.join(tmp, 'dist'), walk(path.join(tmp, 'dist')))
    const localTree = treeHash(DIST, localFiles)
    treeOk = asarTree === localTree && localFiles.length === distInAsar.length
    treeDetail = `${localFiles.length} fichiers dist, ${asarTree.slice(0, 12)} (asar) / ${localTree.slice(0, 12)} (build)`
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  add('renderer (dist/)', treeOk, treeDetail)

  const pkgInst = sha(asar.extractFile(INSTALLED_ASAR, 'package.json'))
  const pkgSrc = sha(Buffer.from(normalizedPackageJson(), 'utf8'))
  add('package.json', pkgInst === pkgSrc, `${pkgSrc.slice(0, 12)} (source normalisée) / ${pkgInst.slice(0, 12)} (asar)`)

  const asarSha = shaFile(INSTALLED_ASAR)
  if (exists(HASHES)) {
    const base = JSON.parse(fs.readFileSync(HASHES, 'utf8'))
    const want = base?.install?.asarSha256
    add('empreinte asar enregistrée', !want || want.toLowerCase() === asarSha, `${asarSha.slice(0, 12)} / ${String(want).slice(0, 12)}`)
    const wantGw = base?.install?.gatewaySha256
    add('empreinte gateway enregistrée', !wantGw || wantGw.toLowerCase() === gwInst, `${gwInst.slice(0, 12)} / ${String(wantGw).slice(0, 12)}`)
  }

  const failed = checks.filter((c) => !c.ok)
  return {
    test: 'T01',
    status: failed.length ? 'FAIL' : 'PASS',
    checks,
    detail: failed.length ? failed.map((f) => `${f.name}: ${f.detail}`).join(' ; ') : checks.map((c) => `${c.name} ${c.detail}`).join(' ; '),
    code: failed.length ? 1 : 0,
    asarSha256: asarSha,
    asarBytes: fs.statSync(INSTALLED_ASAR).size,
    gatewaySha256: gwInst,
    gatewayBytes: fs.statSync(INSTALLED_GW).size,
    distTreeSha256: treeHash(DIST, shipped(DIST))
  }
}

function rebuild() {
  if (!exists(DIST)) {
    return { test: 'T03', status: 'SKIP', checks: [], detail: "apps/desktop/dist absent : lancer `npm run build` d'abord", code: 2 }
  }
  const checks = []
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }) }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarod-t03-'))
  const snapshot = path.join(tmp, 'dist-snapshot')
  const vite = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite')
  copyTree(DIST, snapshot)
  const before = treeHash(DIST, shipped(DIST))
  const build = () => {
    execFileSync(vite, ['build'], { cwd: DESKTOP, stdio: 'pipe', env: BUILD_ENV, shell: process.platform === 'win32' })
    execFileSync(process.execPath, [path.join(DESKTOP, 'scripts', 'bundle-electron.mjs')], { cwd: DESKTOP, stdio: 'pipe', env: BUILD_ENV })
    return treeHash(DIST, shipped(DIST))
  }
  try {
    // 1. deux builds complets (renderer vite + shell esbuild) aux chemins réels du projet
    const b1 = build()
    const b2 = build()
    add('build reproductible (2 builds)', b1 === b2, `${b1.slice(0, 12)} / ${b2.slice(0, 12)}`)
    add('build == arbre livré (dist)', b2 === before, `${b2.slice(0, 12)} (reconstruit) / ${before.slice(0, 12)} (dist livré)`)

    // 2. coeur : deux bundle du gateway, comparés au build livré
    const g1 = path.join(tmp, 'g1')
    const g2 = path.join(tmp, 'g2')
    for (const g of [g1, g2]) {
      execFileSync(process.execPath, [path.join(REPO, 'jarod-core', 'scripts', 'bundle-gateway.mjs'), '--out', g], { cwd: REPO, stdio: 'pipe', env: BUILD_ENV })
    }
    const h1 = shaFile(path.join(g1, 'gateway.mjs'))
    const h2 = shaFile(path.join(g2, 'gateway.mjs'))
    const hd = shaFile(GW_FILE)
    add('gateway reproductible', h1 === h2, `${h1.slice(0, 12)} / ${h2.slice(0, 12)}`)
    add('gateway == build de S:', h1 === hd, `${h1.slice(0, 12)} (reconstruit) / ${hd.slice(0, 12)} (dist)`)

    // 3. le shell livré, comparé à celui de l'installation
    if (installed()) {
      const filesInAsar = asarFiles(INSTALLED_ASAR)
      const compared = walk(DIST).filter((f) => f.startsWith('electron/') && !f.endsWith('.map'))
      const diffWithAsar = compared.filter((f) => {
        const rel = `dist/${f}`
        if (!filesInAsar.includes(rel)) return true
        return sha(asar.extractFile(INSTALLED_ASAR, rel.replace(/\//g, '\\'))) !== shaFile(path.join(DIST, f))
      })
      add('shell == asar installé', diffWithAsar.length === 0, diffWithAsar.length ? `${diffWithAsar.length} écart(s) : ${diffWithAsar.slice(0, 3).join(', ')}` : `${compared.length} fichiers identiques`)
    }
  } finally {
    fs.rmSync(DIST, { recursive: true, force: true })
    copyTree(snapshot, DIST)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  const failed = checks.filter((c) => !c.ok)
  return {
    test: 'T03',
    status: failed.length ? 'FAIL' : 'PASS',
    checks,
    detail: checks.map((c) => `${c.ok ? 'ok' : 'ECART'} ${c.name} ${c.detail}`).join(' ; '),
    code: failed.length ? 1 : 0
  }
}

function status() {
  return {
    repo: REPO,
    installRoot: INSTALL_ROOT,
    installed: installed(),
    gateway: { path: GW_FILE, sha256: exists(GW_FILE) ? shaFile(GW_FILE) : null, bytes: exists(GW_FILE) ? fs.statSync(GW_FILE).size : null },
    dist: { path: DIST, treeSha256: exists(DIST) ? treeHash(DIST, shipped(DIST)) : null },
    asar: { path: INSTALLED_ASAR, sha256: exists(INSTALLED_ASAR) ? shaFile(INSTALLED_ASAR) : null, bytes: exists(INSTALLED_ASAR) ? fs.statSync(INSTALLED_ASAR).size : null }
  }
}

function write() {
  const s = status()
  const prev = exists(HASHES) ? JSON.parse(fs.readFileSync(HASHES, 'utf8')) : {}
  const doc = {
    note: "Empreintes de « installation == build de S: » (T01/T03). check compare l'installation à ces valeurs ; write les recalcule après un build et une installation faits depuis S:.",
    source: 'S: (monorepo, branche feature/trust-matrix)',
    updated: new Date().toISOString().slice(0, 10),
    install: {
      root: INSTALL_ROOT,
      asarSha256: s.asar.sha256,
      asarBytes: s.asar.bytes,
      gatewaySha256: s.gateway.sha256,
      gatewayBytes: s.gateway.bytes
    },
    build: {
      gatewayPath: 'jarod-core/dist/gateway/gateway.mjs',
      distPath: 'apps/desktop/dist',
      distTreeSha256: s.dist.treeSha256,
      distTreeNote: "arbre dist/ sans les *.map (ce que l'asar embarque)"
    },
    chain: {
      gateway: { ...(prev.chain?.gateway || {}), current: s.gateway.sha256 },
      asar: { ...(prev.chain?.asar || {}), current: s.asar.sha256 }
    }
  }
  fs.mkdirSync(path.dirname(HASHES), { recursive: true })
  fs.writeFileSync(HASHES, JSON.stringify(doc, null, 2) + '\n')
  return { wrote: HASHES, ...doc }
}

let result
switch (cmd) {
  case 'check': result = check(); break
  case 'rebuild': result = rebuild(); break
  case 'write': result = write(); break
  case 'status': result = status(); break
  default:
    console.error(`commande inconnue : ${cmd} (check, rebuild, write, status)`)
    process.exit(64)
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else if (result.checks) {
  for (const c of result.checks) console.log(`${c.ok ? 'PASS' : 'ECART'} ${String(c.name).padEnd(30)} ${c.detail}`)
  console.log('')
  console.log(`${result.test} ${result.status} — ${result.detail}`)
} else {
  console.log(JSON.stringify(result, null, 2))
}
process.exit(result.code ?? 0)
