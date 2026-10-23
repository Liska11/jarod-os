// Prepares the restic Jarod-OS ships (G4, encrypted archive under the external backup): engines/restic/bundle -> resources/restic in the
// Windows package. Every hash is checked HERE, at packaging time, against jarod-core/engines.lock/restic.json — and the packaging stops on any
// difference, never ships a binary it could not verify:
//  - the official zip (engines/restic/dl) against the release's SHA256SUMS hash;
//  - the executable extracted from that zip (Windows tar.exe), against its pinned hash;
//  - the BSD-2-Clause licence text, shipped beside it (the licence requires the notice with the binary).
// Without the zip, the already-extracted engines/restic/restic.exe is accepted only if its own hash matches.
//
//   node scripts/bundle-restic.mjs
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
// JAROD_RESTIC_LOCK : un autre fichier de verrou (seulement pour éprouver le refus d'une empreinte fausse).
const lock = JSON.parse(readFileSync(process.env.JAROD_RESTIC_LOCK || path.join(repo, 'jarod-core', 'engines.lock', 'restic.json'), 'utf8'))
const engine = path.join(repo, 'engines', 'restic')
const out = path.join(engine, 'bundle')

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

function must(file, expected, what) {
  if (!existsSync(file)) throw new Error(`${what} introuvable : ${file}`)

  const got = sha256(file)

  if (got !== expected) throw new Error(`${what} : empreinte ${got}, attendue ${expected} (${file}) — empaquetage arrêté`)
  console.log(`  ✓ ${what} ${got.slice(0, 16)}…`)
}

console.log(`restic ${lock.version} pour le paquet Windows :`)
let exe
let work = null
const zip = path.join(engine, 'dl', lock.zip.name)

if (existsSync(zip)) {
  must(zip, lock.zip.sha256, 'archive officielle')
  work = mkdtempSync(path.join(tmpdir(), 'jarod-restic-bundle-'))
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const r = spawnSync(tar, ['-xf', zip, '-C', work, lock.exe.name], { stdio: 'inherit' })

  if (r.status !== 0) throw new Error(`extraction impossible (tar.exe, code ${r.status})`)
  exe = path.join(work, lock.exe.name)
} else {
  console.log(`  (archive absente : ${zip} ; l'exécutable déjà extrait doit avoir l'empreinte attendue)`)
  exe = path.join(engine, 'restic.exe')
}

try {
  must(exe, lock.exe.sha256, 'exécutable')
  const license = path.join(repo, lock.license.path)
  must(license, lock.license.sha256, `licence ${lock.license.spdx}`)

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  copyFileSync(exe, path.join(out, 'restic.exe'))
  copyFileSync(license, path.join(out, 'LICENSE.txt'))
  writeFileSync(path.join(out, 'VERSION.json'), `${JSON.stringify({ version: lock.version, release: lock.release, exeSha256: lock.exe.sha256, zipSha256: lock.zip.sha256, license: lock.license.spdx }, null, 2)}\n`)
  // Re-read what will ship: the copy is the verified file.
  must(path.join(out, 'restic.exe'), lock.exe.sha256, 'copie à empaqueter')
  console.log(`  → ${out}`)
} finally {
  if (work) rmSync(work, { recursive: true, force: true })
}
