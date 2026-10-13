// Prepares the Pinokio engine Jarod-OS ships (ADR-022): pinokio-runtime/ -> node_modules for pinokiod plus host.cjs.
// electron-builder copies the folder to resources/pinokiod; a development checkout runs it from where it is
// (electron/pinokio/service.ts). Jarod-OS runs it with its own executable in Node mode, so its native modules are made for
// this checkout's Electron:
//  - better-sqlite3 is compiled against Electron's headers (no prebuilt binary exists for recent Electron versions);
//  - pinokiod's terminal module (@homebridge/node-pty-prebuilt-multiarch, prebuilt for Node only) is replaced by a shim
//    over node-pty 1.1.0, the one Jarod-OS's own terminal uses (N-API, so it loads in any Node);
//  - the other natives (@parcel/watcher, koffi) are N-API already.
// Files for other platforms are left out. A stamp skips the work when nothing changed.
//
//   node scripts/bundle-pinokio.mjs [--force]
//
// Needs a C++ toolchain on Windows (Visual Studio Build Tools) for better-sqlite3.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(here, '..')
const repo = path.resolve(desktop, '..', '..')
const runtime = path.join(repo, 'pinokio-runtime')
const modules = path.join(runtime, 'node_modules')
const stampFile = path.join(runtime, '.bundle-stamp.json')
const force = process.argv.includes('--force')
const require = createRequire(path.join(desktop, 'package.json'))
const electronVersion = require('electron/package.json').version
const platform = process.platform
const arch = process.arch

function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: platform === 'win32' && !command.endsWith('.exe') && command !== process.execPath, ...extra })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.message})`)
  }
}

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16)
const stamp = {
  lock: hash(readFileSync(path.join(runtime, 'package-lock.json'))),
  host: hash(['host.ts', 'guard.ts', 'protocol.ts'].map(file => readFileSync(path.join(desktop, 'electron', 'pinokio', file))).join('\0')),
  electron: electronVersion,
  platform,
  arch
}
const previous = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')) : null
const modulesCurrent = !force && previous && previous.lock === stamp.lock && previous.electron === stamp.electron && previous.platform === platform && previous.arch === arch && existsSync(path.join(modules, 'pinokiod'))

if (!modulesCurrent) {
  // 1. pinokiod and its dependencies, exactly as locked, without their install scripts (we do their job below, for Electron).
  rmSync(modules, { recursive: true, force: true })
  run('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--workspaces=false'], runtime)

  // 2. The terminal module: a shim over node-pty.
  const pty = path.join(modules, '@homebridge', 'node-pty-prebuilt-multiarch')
  rmSync(pty, { recursive: true, force: true })
  mkdirSync(pty, { recursive: true })
  writeFileSync(path.join(pty, 'package.json'), `${JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '0.12.0-jarod-os', main: 'index.js', description: "Jarod-OS shim: pinokiod's terminal module, served by node-pty (N-API)." }, null, 2)}\n`)
  writeFileSync(path.join(pty, 'index.js'), "'use strict'\n// Jarod-OS (scripts/bundle-pinokio.mjs): node-pty's API is the one pinokiod uses (spawn, onData, write, resize, kill).\nmodule.exports = require('node-pty')\n")

  // 3. better-sqlite3 against Electron's headers.
  const gyp = require.resolve('node-gyp/bin/node-gyp.js')
  run(process.execPath, [gyp, 'rebuild', '--release', '--runtime=electron', `--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers', `--arch=${arch}`], path.join(modules, 'better-sqlite3'))
  // Only the module itself is loaded (bindings looks for build/Release/better_sqlite3.node); the rest is compiler output.
  const sqliteBuild = path.join(modules, 'better-sqlite3', 'build')
  const sqliteModule = readFileSync(path.join(sqliteBuild, 'Release', 'better_sqlite3.node'))
  rmSync(sqliteBuild, { recursive: true, force: true })
  mkdirSync(path.join(sqliteBuild, 'Release'), { recursive: true })
  writeFileSync(path.join(sqliteBuild, 'Release', 'better_sqlite3.node'), sqliteModule)
  rmSync(path.join(modules, 'better-sqlite3', 'deps'), { recursive: true, force: true })
  rmSync(path.join(modules, 'better-sqlite3', 'src'), { recursive: true, force: true })

  // 4. What this platform never loads.
  prune()
}

// 5. The host, compiled next to node_modules.
await build({
  entryPoints: [path.join(desktop, 'electron', 'pinokio', 'host.ts')],
  outfile: path.join(runtime, 'host.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['pinokiod'],
  logLevel: 'warning'
})

// 6. Proof that it loads where it will run: Electron in Node mode, with the natives pinokiod opens at start.
const electron = require('electron')
const probe = spawnSync(
  electron,
  ['-e', "const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); require('@homebridge/node-pty-prebuilt-multiarch'); require('@parcel/watcher'); process.stdout.write('ok')"],
  { cwd: runtime, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 }
)

if (probe.status !== 0 || probe.stdout !== 'ok') {
  console.error(probe.stderr || probe.stdout)
  throw new Error("pinokiod's native modules do not load in this Electron; run again with --force")
}

writeFileSync(stampFile, `${JSON.stringify(stamp, null, 2)}\n`)
console.log(`Pinokio engine ready in ${runtime} (pinokiod ${JSON.parse(readFileSync(path.join(modules, 'pinokiod', 'package.json'), 'utf8')).version}, Electron ${electronVersion}, ${size(runtime)} MB)`)

function prune() {
  const platformTag = `${platform}-${arch}`
  // Prebuilt binaries for other systems.
  for (const dir of [path.join(modules, 'node-pty', 'prebuilds')]) {
    if (!existsSync(dir)) {
      continue
    }

    for (const name of readdirSync(dir)) {
      if (!name.startsWith(platformTag) && name !== `${platform}_${arch}`) {
        rmSync(path.join(dir, name), { recursive: true, force: true })
      }
    }
  }

  // 7-Zip ships one binary per system and processor (7zip-bin/<os>/<arch>).
  const sevenZip = path.join(modules, '7zip-bin')
  const sevenZipOs = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'

  if (existsSync(sevenZip)) {
    for (const name of readdirSync(sevenZip)) {
      const entry = path.join(sevenZip, name)

      if (statSync(entry).isDirectory()) {
        if (name !== sevenZipOs) {
          rmSync(entry, { recursive: true, force: true })
        } else {
          for (const cpu of readdirSync(entry)) {
            if (cpu !== arch) {
              rmSync(path.join(entry, cpu), { recursive: true, force: true })
            }
          }
        }
      }
    }
  }

  // The folder-size helper: one Go build per system (dist/go-get-folder-size_<os>_<arch>[_v1]).
  const goDist = path.join(modules, 'go-get-folder-size', 'dist')
  const goOs = platform === 'win32' ? 'windows' : platform
  const goArch = arch === 'x64' ? 'amd64' : arch === 'ia32' ? '386' : arch

  if (existsSync(goDist)) {
    for (const name of readdirSync(goDist)) {
      if (name.startsWith('go-get-folder-size_') && !name.startsWith(`go-get-folder-size_${goOs}_${goArch}`)) {
        rmSync(path.join(goDist, name), { recursive: true, force: true })
      }
    }
  }

  // Sources maps, type declarations and test folders are never loaded.
  walk(modules, entry => {
    const name = path.basename(entry)

    if (statSync(entry).isDirectory()) {
      if (name === 'test' || name === 'tests' || name === '__tests__' || name === '.github') {
        rmSync(entry, { recursive: true, force: true })

        return false
      }

      return true
    }

    if (name.endsWith('.map') || name.endsWith('.d.ts') || name.endsWith('.pdb')) {
      rmSync(entry, { force: true })
    }

    return true
  })
}

function walk(dir, visit) {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name)

    if (visit(entry) !== false && existsSync(entry) && statSync(entry).isDirectory()) {
      walk(entry, visit)
    }
  }
}

function size(dir) {
  let total = 0
  walk(dir, entry => {
    const info = statSync(entry)

    if (info.isFile()) {
      total += info.size
    }

    return true
  })

  return Math.round(total / 1048576)
}
