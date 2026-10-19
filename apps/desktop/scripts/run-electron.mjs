// Start Electron on the app folder, optionally pointed at the Vite dev server. This replaces the
// inline `JAROD_OS_DEV_SERVER=... electron .` of the dev script, which cmd.exe cannot parse.
//   node scripts/run-electron.mjs [--dev-server <url>]
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const args = process.argv.slice(2)
const flag = args.indexOf('--dev-server')
const env = { ...process.env }

if (flag !== -1) {
  env.JAROD_OS_DEV_SERVER = args[flag + 1]
  args.splice(flag, 2)
}

delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.', ...args], { cwd: root, env, stdio: 'inherit' })

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
