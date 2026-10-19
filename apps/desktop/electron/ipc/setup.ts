import { BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IPC, type SetupResult, type SetupState } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { loadPty } from './terminal.ts'
import { type HostControlGate } from '../shell/host-control.ts'
import { checkBot, roundTrip } from '../setup/telegram.ts'
import { shellConfigDir } from '../paths.ts'

/*
 * First-run setup. On Windows (`desktop` mode) it is due until this install was set up once: the system audit, then
 * the accounts; `JAROD_OS_SKIP_SETUP=1` skips it (throwaway profiles, tests).
 *
 * First-boot setup on the Jarod-OS image: the image's first boot made the account (no password)
 * and installed Hermes; the person names it, sets a password, joins Wi-Fi and signs in to Hermes.
 * Nothing here needs root: `passwd` changes the person's own password (the current one is empty on
 * a new account), and the name Herald greets with lives in ~/.config/herald-os/name.
 */

const FIRSTBOOT_DONE = '/var/lib/herald-os/firstboot-done'
const configDir = () => shellConfigDir()
const doneFile = () => path.join(configDir(), 'setup-done')
export const nameFile = (): string => path.join(configDir(), 'name')

export function setupState(): SetupState {
  const image = fs.existsSync(FIRSTBOOT_DONE) || process.env.JAROD_OS_FORCE_SETUP === '1'
  let name = ''

  try {
    name = fs.readFileSync(nameFile(), 'utf8').trim()
  } catch {
    // Not named yet.
  }

  const done = fs.existsSync(doneFile())

  if (process.platform === 'win32') {
    return { needed: !done && process.env.JAROD_OS_SKIP_SETUP !== '1', mode: 'desktop', user: os.userInfo().username, name }
  }

  return { needed: process.platform === 'linux' && image && !done, mode: 'image', user: os.userInfo().username, name }
}

/** What `passwd` asks (LANG=C), most specific first: "Retype new password:" also ends in "new password:". */
export function passwdReply(screen: string, password: string, current: string): string | null {
  const tail = screen.slice(-160).toLowerCase()

  if (/retype new password:\s*$/.test(tail)) {
    return `${password}\r`
  }

  if (/new password:\s*$/.test(tail)) {
    return `${password}\r`
  }

  if (/(current|\(current\) unix|old) password:\s*$/.test(tail) || /password:\s*$/.test(tail)) {
    return `${current}\r`
  }

  return null
}

/** `passwd` for this account, answered through a terminal; the reason when it refuses (too short, too simple). */
export function changePassword(password: string, current = ''): Promise<SetupResult> {
  const pty = loadPty()

  if (!pty) {
    return Promise.resolve({ ok: false, error: 'The terminal library is missing, so the password cannot be set here; run `passwd` in a terminal.' })
  }

  return new Promise(resolve => {
    const child = pty.spawn('passwd', [], { name: 'xterm', cols: 100, rows: 24, cwd: os.homedir(), env: { ...process.env, LANG: 'C', LC_ALL: 'C' } })
    let screen = ''
    let refusal = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: 'passwd did not finish' })
    }, 30_000)

    child.onData(data => {
      screen += data
      const bad = /BAD PASSWORD: ([^\r\n]+)/.exec(screen)

      if (bad?.[1]) {
        // pwquality refused it and would ask again; stop and say why.
        refusal = bad[1].trim()
        child.kill()

        return
      }

      const reply = passwdReply(screen, password, current)

      if (reply !== null) {
        screen = ''
        child.write(reply)
      }
    })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)

      if (exitCode === 0) {
        resolve({ ok: true })
      } else {
        const last = screen.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? ''
        log('setup', `passwd exited ${exitCode}: ${refusal || last}`)
        resolve({ ok: false, error: refusal ? `That password was refused: ${refusal}.` : last || 'passwd refused the change' })
      }
    })
  })
}

export function registerSetupIpc(gate: HostControlGate): void {
  // Logged for diagnosis: the outcome and the bot's name, never the token.
  ipcMain.handle(IPC.setupTelegramCheck, async (_event, token: unknown) => {
    const bot = await checkBot(String(token ?? ''))
    log('setup', bot.ok ? `telegram: token accepted for @${bot.username ?? '?'}` : `telegram: token refused (${bot.code ?? 'error'})`)
    return bot
  })
  ipcMain.handle(IPC.setupTelegramTest, async (_event, token: unknown, reply: unknown) => {
    const trip = await roundTrip(String(token ?? ''), String(reply ?? 'Jarod-OS is connected.').slice(0, 500), { waitSeconds: 120 })
    log('setup', trip.ok ? 'telegram: round trip ok' : `telegram: round trip failed (${trip.code ?? 'error'})`)
    return trip
  })
  ipcMain.handle(IPC.setupState, () => setupState())
  ipcMain.handle(IPC.setupName, (_event, name: string) => {
    const clean = String(name ?? '').replace(/[\r\n:]/g, ' ').trim().slice(0, 64)
    fs.mkdirSync(configDir(), { recursive: true })
    fs.writeFileSync(nameFile(), `${clean}\n`)

    return { ok: true } satisfies SetupResult
  })
  // R3.1: setting the account password changes the machine, so the action is named, tiered
  // (`cli.password` is `destructive`) and written down like any other host action. The password
  // itself is deliberately not an argument of that action: the gate records what was asked for, never
  // the secret, and the value stays between this handler and `passwd`.
  ipcMain.handle(IPC.setupPassword, async (event, password: string): Promise<SetupResult> => {
    // The password is a host mutation like any other, so it takes both halves of the IPC policy: the
    // sender is a window of this app, and the action is the catalogued one (R3.2).
    if (!BrowserWindow.fromWebContents(event.sender)) {
      log('setup', 'refused a password change from a window that is not a herald-os surface')

      return { ok: false, error: 'This window may not change the account password.' }
    }

    const value = String(password ?? '')

    if (value.length < 8 || /[\r\n]/.test(value)) {
      return { ok: false, error: 'Use at least 8 characters.' }
    }

    const gated = await gate.submitLocal({ client: 'ui', command: 'cli.password', args: {}, source: 'setup' })

    if (gated.kind === 'reply') {
      return { ok: false, error: gated.reply.error ?? 'The shell refused that change.' }
    }

    try {
      const result = await changePassword(value)

      gated.finish({ ok: result.ok, reason: result.ok ? undefined : result.error })

      return result
    } catch (error) {
      gated.finish({ ok: false, code: 'execution-failed', reason: error instanceof Error ? error.message : String(error) })

      throw error
    }
  })
  // `later`: set up for someone else; setup shows again for them at the next start.
  ipcMain.handle(IPC.setupFinish, (_event, options: { later?: boolean } = {}) => {
    if (!options.later) {
      fs.mkdirSync(configDir(), { recursive: true })
      fs.writeFileSync(doneFile(), `${new Date().toISOString()}\n`)
    }

    log('setup', options.later ? 'first-run setup left for the next start' : 'first-run setup finished')

    return { ok: true } satisfies SetupResult
  })
}
