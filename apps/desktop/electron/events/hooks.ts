import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type HeraldEvent, hookEnv } from '../../shared/events.ts'
import { log } from '../log.ts'

/** A hook that runs longer than this is stopped: hooks are for quick chores, not services. */
const HOOK_TIMEOUT_MS = 120_000

export function hooksDir(): string {
  return path.join(os.homedir(), '.config', 'herald-os', 'hooks')
}

/** Windows has no executable bit: a hook is a file of a type the system can run. */
const WINDOWS_HOOK_EXTENSIONS = new Set(['.exe', '.cmd', '.bat', '.ps1'])

/** The scripts that run for an event: executable files in `<event>.d`, in name order (`.sample` files and dotfiles skipped). */
export function hookScripts(dir: string, platform: NodeJS.Platform = process.platform): string[] {
  let names: string[]

  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    return []
  }

  return names
    .filter(name => !name.startsWith('.') && !name.endsWith('.sample') && !name.endsWith('~'))
    .map(name => path.join(dir, name))
    .filter(file => {
      try {
        const stat = fs.statSync(file)

        return stat.isFile() && (platform === 'win32' ? WINDOWS_HOOK_EXTENSIONS.has(path.extname(file).toLowerCase()) : (stat.mode & 0o111) !== 0)
      } catch {
        return false
      }
    })
}

/** What to start for a hook script: scripts need their interpreter on Windows, which spawn cannot infer. */
export function hookCommand(script: string, eventName: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  const extension = path.extname(script).toLowerCase()

  if (platform === 'win32' && extension === '.ps1') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, eventName] }
  }

  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    return { file: 'cmd.exe', args: ['/d', '/c', script, eventName] }
  }

  return { file: script, args: [eventName] }
}

/** Run the person's hook scripts for an event, each with the event in its environment. Never waits on them. */
export function runHooks(event: HeraldEvent): void {
  for (const script of hookScripts(path.join(hooksDir(), `${event.name}.d`))) {
    const { file, args } = hookCommand(script, event.name)
    const child = spawn(file, args, { env: { ...process.env, ...hookEnv(event) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-2000)
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), HOOK_TIMEOUT_MS)
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => log('hooks', `${script}: ${error.message}`))
    child.on('exit', code => {
      clearTimeout(timer)
      log('hooks', `${event.name}: ${path.basename(script)} exited ${code ?? 'by signal'}${output.trim() ? `: ${output.trim().slice(-400)}` : ''}`)
    })
  }
}
