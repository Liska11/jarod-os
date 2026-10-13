// Builds the Jarod core that ships inside the app: jarod-core/ -> one JavaScript file plus the native SQLite module (jarod-core/scripts/bundle-gateway.mjs).
// The result, jarod-core/dist/gateway, is what electron-builder puts in resources/jarod-core and what a development checkout runs
// (electron/backend/jarod-core.ts). Jarod-OS runs it with its own executable in Node mode when the native module loads there (checked below);
// otherwise, or with JAROD_SHIP_NODE=1, the Node that built it is copied beside it so the native module and the runtime always match.
//
//   node scripts/bundle-core.mjs
//
// Needs pnpm (jarod-core is its own workspace with its own lockfile).
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const core = path.resolve(here, '..', '..', '..', 'jarod-core')
const out = path.join(core, 'dist', 'gateway')

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: command === 'pnpm' && process.platform === 'win32' })

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error?.message})`)
  }
}

const pnpm = spawnSync('pnpm', ['--version'], { shell: process.platform === 'win32', encoding: 'utf8' })

if (pnpm.status !== 0) {
  console.error('pnpm is required to build the Jarod core (jarod-core is a pnpm workspace). Install it with `npm install -g pnpm` or `corepack enable`.')
  process.exit(1)
}

if (!existsSync(path.join(core, 'node_modules'))) {
  run('pnpm', ['install', '--prefer-frozen-lockfile'], core)
}

run(process.execPath, [path.join(core, 'scripts', 'bundle-gateway.mjs'), '--out', out], core)

const runtime = path.join(out, process.platform === 'win32' ? 'node.exe' : 'node')
const license = path.join(out, 'NODE-LICENSE.txt')

/**
 * Jarod-OS can run the core with its own executable in Node mode (ELECTRON_RUN_AS_NODE), which spares the installer a second Node (~90 MB).
 * That only works when the core's native module loads in Electron's Node: checked here, with this checkout's Electron, by opening a database.
 * When it does not (a module built for one Node ABI only), the Node that built it is shipped beside it, as before.
 */
function electronRunsTheCore() {
  let electron

  try {
    electron = createRequire(path.join(here, '..', 'package.json'))('electron')
  } catch {
    return false
  }

  const probe = spawnSync(electron, ['-e', "const D = require('better-sqlite3-multiple-ciphers'); new D(':memory:').prepare('select 1').get(); process.stdout.write('ok')"], {
    cwd: out,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000
  })

  return probe.status === 0 && probe.stdout === 'ok'
}

if (process.env.JAROD_SHIP_NODE !== '1' && electronRunsTheCore()) {
  rmSync(runtime, { force: true })
  rmSync(license, { force: true })
  console.log(`Jarod core ready in ${out}: Jarod-OS runs it in Node mode (its native module loads in Electron's Node), no separate Node shipped`)
  process.exit(0)
}

copyFileSync(process.execPath, runtime)
writeFileSync(
  license,
  `The file ${path.basename(runtime)} is Node.js ${process.version}, copied unmodified from the machine that built this package.

Node.js is released under the MIT license. Copyright Node.js contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: the above copyright notice and this permission
notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

Node.js bundles third-party components (V8, OpenSSL, ICU, libuv, ...) under their own licenses; the complete list is in
https://github.com/nodejs/node/blob/${process.version}/LICENSE
`
)
console.log(`Jarod core ready in ${out} (Node ${process.version})`)
