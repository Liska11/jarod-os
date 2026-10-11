#!/usr/bin/env node
// Cross-platform entry for the repo's maintenance scripts: `node scripts/run.mjs <name> [args...]`
// runs scripts/<name>.sh with bash on macOS and Linux, and scripts/<name>.ps1 with PowerShell on
// Windows (where `bash` can resolve to the WSL launcher, which is not what these scripts want).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const [name, ...args] = process.argv.slice(2)

if (!name) {
  console.error('usage: node scripts/run.mjs <script-name> [args...]')
  process.exit(2)
}

const windows = process.platform === 'win32'
const file = path.join(here, `${name}.${windows ? 'ps1' : 'sh'}`)

if (!fs.existsSync(file)) {
  console.error(`run: ${path.relative(process.cwd(), file)} does not exist for ${process.platform}`)
  process.exit(2)
}

const [command, commandArgs] = windows ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]] : ['bash', [file, ...args]]
const result = spawnSync(command, commandArgs, { stdio: 'inherit' })

if (result.error) {
  console.error(`run: could not start ${command}: ${result.error.message}`)
  process.exit(127)
}

process.exit(result.status ?? 1)
