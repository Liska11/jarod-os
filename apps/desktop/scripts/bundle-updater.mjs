// Prepares the Rust binaries Jarod-OS ships: host-rust/target/updater-bundle -> resources/updater in the Windows package.
//  - jarod-updater.exe and jarod-launcher.exe, built here in RELEASE (the only kind that trusts nothing but the committed key and refuses
//    a test key) — the A/B updater (V-21, off unless JAROD_HOST_UPDATER=1);
//  - jarod-control-shadow.exe, the Rust adjudicator in the shadow of the door (V-22, off unless JAROD_HOST_CONTROL=1; it never decides);
//  - contracts/v1, which the manifests are checked against (the binaries have no built-in copy, on purpose).
// Without cargo the packaging stops: it never ships an updater it did not build from this checkout.
//
//   node scripts/bundle-updater.mjs
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')
const host = path.join(repo, 'host-rust')
const out = path.join(host, 'target', 'updater-bundle')
const exe = name => (process.platform === 'win32' ? `${name}.exe` : name)

console.log('jarod-updater, jarod-launcher et jarod-control-shadow pour le paquet Windows :')
for (const targets of [['-p', 'host-updater', '--bins'], ['-p', 'host-control', '--bin', 'jarod-control-shadow']]) {
  const build = spawnSync('cargo', ['build', '--release', '--locked', ...targets], { cwd: host, stdio: 'inherit', shell: process.platform === 'win32' })

  if (build.status !== 0) throw new Error(`cargo build a échoué (code ${build.status ?? build.error?.message}) — empaquetage arrêté`)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

for (const name of ['jarod-updater', 'jarod-launcher', 'jarod-control-shadow']) {
  const built = path.join(host, 'target', 'release', exe(name))

  if (!existsSync(built)) throw new Error(`${built} introuvable après la compilation — empaquetage arrêté`)
  copyFileSync(built, path.join(out, exe(name)))
  console.log(`  ✓ ${exe(name)}`)
}

cpSync(path.join(repo, 'contracts', 'v1'), path.join(out, 'contracts', 'v1'), { recursive: true })
if (!existsSync(path.join(out, 'contracts', 'v1', 'index.json'))) throw new Error('contracts/v1 incomplet — empaquetage arrêté')
console.log('  ✓ contracts/v1')
console.log(`-> ${out}`)
