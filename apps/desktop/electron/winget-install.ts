import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { assertInternet, internetAllowed } from './network.ts'
import { WINGET_UPGRADE_ACTION } from './shell/host-actions.ts'
import type { HostControlGate } from './shell/host-control.ts'
import { type UpdateItem, WINGET_ID } from './updates-check.ts'

/*
 * Upgrading one winget package from Système › Mises à jour (docs/UPDATES.md), and nothing else: the package must be one the last check
 * listed, the person confirms its exact id, version and source, and only then does winget run, with an argument array (no shell), the id
 * matched exactly, the version and source pinned to what was confirmed, and the agreements accepted on the person's behalf because they
 * just read and confirmed them. There is no "upgrade all", Windows Update and drivers stay read-only, and nothing runs while Jarod's
 * Internet is off. The caller (electron/ipc/updates-check.ts) takes the control gate and writes the journal line.
 */

/** The catalogue id of this action: the gate tiers it, the journal names it. */
export { WINGET_UPGRADE_ACTION }

/** What the person confirms: exactly this package, at exactly this version, from exactly this source. */
export interface WingetTarget {
  id: string
  version: string
  source: string
}

/** The plan shown in the confirmation; `token` is spent by the one upgrade it allows. */
export interface WingetPlan extends WingetTarget {
  name: string
  current: string | null
  token: string
  /** The command as it will run, for the person to read. */
  command: string[]
  expiresAt: number
}

export type WingetOutcome = 'success' | 'reboot-required' | 'failed' | 'cancelled'

export interface WingetResult {
  outcome: WingetOutcome
  /** winget's exit code, as the unsigned HRESULT it documents (0x8A15…). */
  exitCode: number | null
  /** One sentence for the person. */
  message: string
}

export interface WingetProgress {
  id: string
  phase: 'starting' | 'downloading' | 'verifying' | 'installing' | 'done'
  /** 0–100 when winget printed a percentage or a size, else null. */
  percent: number | null
  /** The last meaningful line winget printed, for the person to follow. */
  line: string
}

/** A version or a source as winget prints them: no spaces, no option, nothing a shell would read. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_~-]{0,63}$/
const SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

/** Why `target` may not be upgraded, or null when it may. */
export function targetProblem(target: Partial<WingetTarget> | null | undefined): string | null {
  if (!target || typeof target !== 'object') return 'aucun paquet indiqué'
  if (typeof target.id !== 'string' || !WINGET_ID.test(target.id)) return 'identifiant de paquet winget invalide'
  if (typeof target.version !== 'string' || !VERSION.test(target.version) || /^unknown$/i.test(target.version)) return 'version cible invalide'
  if (typeof target.source !== 'string' || !SOURCE.test(target.source)) return 'source winget invalide'

  return null
}

/**
 * The winget arguments for one confirmed upgrade. Without a confirmation there is no command at all: the agreements flags and the silent
 * mode are what the confirmation stands for, so they never appear before it.
 */
export function wingetUpgradeArgs(target: WingetTarget, confirmed: boolean): string[] {
  const problem = targetProblem(target)

  if (problem) throw new Error(problem)
  if (confirmed !== true) throw new Error('la mise à jour doit d’abord être confirmée')

  return [
    'upgrade',
    '--id',
    target.id,
    '--exact',
    '--version',
    target.version,
    '--source',
    target.source,
    '--silent',
    '--disable-interactivity',
    '--accept-package-agreements',
    '--accept-source-agreements'
  ]
}

/** The command shown in the confirmation (the same array, read as words). */
export function wingetPreview(target: WingetTarget): string[] {
  return ['winget', ...wingetUpgradeArgs(target, true)]
}

/** winget's documented return codes this screen tells apart (unsigned). */
export const WINGET_CODES: ReadonlyMap<number, { outcome: WingetOutcome; message: string }> = new Map<number, { outcome: WingetOutcome; message: string }>([
  [0x8a150109, { outcome: 'reboot-required', message: 'Installé ; un redémarrage de l’ordinateur est nécessaire pour terminer.' }],
  [0x8a15010a, { outcome: 'failed', message: 'Un redémarrage est nécessaire avant de pouvoir installer cette mise à jour.' }],
  [0x8a15010b, { outcome: 'reboot-required', message: 'L’installateur a demandé un redémarrage.' }],
  [0x8a15010c, { outcome: 'cancelled', message: 'Installation annulée (refus de l’élévation ou de l’installateur).' }],
  [0x8a150101, { outcome: 'failed', message: 'Le logiciel est en cours d’utilisation : fermez-le puis réessayez.' }],
  [0x8a150111, { outcome: 'failed', message: 'Une application utilise ce logiciel : fermez-la puis réessayez.' }],
  [0x8a150102, { outcome: 'failed', message: 'Une autre installation est déjà en cours.' }],
  [0x8a150103, { outcome: 'failed', message: 'Un fichier du logiciel est en cours d’utilisation.' }],
  [0x8a150104, { outcome: 'failed', message: 'Une dépendance manque.' }],
  [0x8a150105, { outcome: 'failed', message: 'Le disque est plein.' }],
  [0x8a150106, { outcome: 'failed', message: 'Mémoire insuffisante.' }],
  [0x8a150107, { outcome: 'failed', message: 'Pas de réseau pendant l’installation.' }],
  [0x8a15010d, { outcome: 'success', message: 'Cette version est déjà installée.' }],
  [0x8a15010e, { outcome: 'failed', message: 'Une version plus récente est déjà installée.' }],
  [0x8a15010f, { outcome: 'failed', message: 'Bloqué par une stratégie de l’organisation.' }],
  [0x8a150113, { outcome: 'failed', message: 'Ce système n’est pas pris en charge par ce paquet.' }],
  [0x8a150114, { outcome: 'failed', message: 'Ce paquet ne peut pas être mis à jour par winget (il faut le réinstaller).' }],
  [0x8a150011, { outcome: 'failed', message: 'L’empreinte de l’installateur ne correspond pas : rien n’a été installé.' }],
  [0x8a150014, { outcome: 'failed', message: 'Paquet introuvable dans cette source.' }],
  [0x8a15002b, { outcome: 'failed', message: 'Aucune mise à jour applicable (déjà à jour, ou version différente).' }]
])

/** A notice that the computer (not the program) must restart, in English or French. */
const RESTART_NOTICE = /reboot|restart (your|the) (pc|computer|device|system)|redémarr\S* (l['’]ordinateur|votre (pc|ordinateur|appareil)|le système)/i

/** Reads how a winget run ended: its exit code first, then its last lines (whatever the language) for a restart notice. */
export function parseWingetResult(exitCode: number | null, output: string, spawnError?: string): WingetResult {
  if (spawnError) {
    const missing = /ENOENT|not recognized|introuvable/i.test(spawnError)

    return { outcome: 'failed', exitCode: null, message: missing ? 'winget n’est pas installé.' : `winget n’a pas pu démarrer : ${spawnError}` }
  }

  if (exitCode === null) return { outcome: 'failed', exitCode: null, message: 'winget s’est arrêté sans code de sortie.' }

  const code = exitCode >>> 0
  const known = WINGET_CODES.get(code)
  const restartNotice = RESTART_NOTICE.test(output.split(/\r?\n/).slice(-12).join('\n'))

  if (code === 0) {
    return restartNotice
      ? { outcome: 'reboot-required', exitCode: 0, message: 'Installé ; un redémarrage de l’ordinateur est nécessaire pour terminer.' }
      : { outcome: 'success', exitCode: 0, message: 'Mise à jour installée.' }
  }

  if (known) return { outcome: known.outcome, exitCode: code, message: known.message }

  const last = meaningfulLines(output).at(-1)

  return { outcome: 'failed', exitCode: code, message: `Échec (code 0x${code.toString(16).toUpperCase()})${last ? ` : ${last}` : '.'}` }
}

/** winget's output without its spinner, progress bars and blank lines. */
function meaningfulLines(output: string): string[] {
  return output
    .split(/[\r\n]+/)
    .map(line => line.replace(/[█▒░▓]+/g, ' ').replace(/^[\s\\|/-]+$/, '').replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 1)
}

/** Follows winget's output: the phase, a percentage when it prints one, and its last line. */
export function readProgress(id: string, chunk: string, previous: WingetProgress | null): WingetProgress {
  const lines = meaningfulLines(chunk)
  const line = lines.at(-1) ?? previous?.line ?? ''
  let phase = previous?.phase ?? 'starting'
  let percent = previous?.percent ?? null

  for (const text of lines) {
    if (/download|télécharg/i.test(text)) phase = 'downloading'
    else if (/hash|empreinte|verif|vérifi/i.test(text)) phase = 'verifying'
    else if (/install/i.test(text)) phase = 'installing'

    const share = text.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/)
    const size = text.match(/([\d.,]+)\s*([KMG]i?B)\s*\/\s*([\d.,]+)\s*([KMG]i?B)/i)

    if (share) percent = Math.min(100, Math.round(Number(share[1].replace(',', '.'))))
    else if (size) {
      const unit = (value: string) => ({ k: 1, m: 1024, g: 1024 * 1024 })[value[0].toLowerCase() as 'k' | 'm' | 'g'] ?? 1
      const done = Number(size[1].replace(',', '.')) * unit(size[2])
      const total = Number(size[3].replace(',', '.')) * unit(size[4])

      if (total > 0) percent = Math.min(100, Math.round((done / total) * 100))
    }
  }

  return { id, phase, percent, line: line.slice(0, 200) }
}

/** Starts winget with an argument array; the e2e suite and the unit tests replace it (no real install ever runs from a test). */
export type WingetSpawner = (args: string[]) => Pick<ChildProcess, 'stdout' | 'stderr' | 'on' | 'kill'>

export const realSpawner: WingetSpawner = args => spawn('winget.exe', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * A scripted winget for the e2e suite (`JAROD_WINGET_MOCK`, honoured only in an isolated profile): it prints the file's lines and exits
 * with its code, and writes the arguments it received beside the file so the test can read them. Nothing is installed.
 */
export function mockSpawner(file: string): WingetSpawner {
  return args => {
    const script = JSON.parse(fs.readFileSync(file, 'utf8')) as { lines?: string[]; exitCode?: number; delayMs?: number }
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
    const lines = Array.isArray(script.lines) ? script.lines.map(String) : []
    const delay = Math.max(0, Math.min(2000, Number(script.delayMs) || 0))

    fs.writeFileSync(`${file}.args.json`, JSON.stringify(args))
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true

    const step = (index: number) => {
      if (index < lines.length) {
        child.stdout.write(`${lines[index]}

`)
        setTimeout(() => step(index + 1), delay)

        return
      }

      child.stdout.end()
      child.emit('close', Number.isInteger(script.exitCode) ? script.exitCode : 0)
    }

    setTimeout(() => step(0), delay)

    return child as unknown as ReturnType<WingetSpawner>
  }
}

/** The winget that runs: the real one, or the e2e suite's scripted one (only in an isolated test profile). */
export function wingetSpawner(env: NodeJS.ProcessEnv = process.env): WingetSpawner {
  const mock = env.JAROD_WINGET_MOCK?.trim()

  return mock && env.JAROD_OS_ISOLATED === '1' ? mockSpawner(mock) : realSpawner
}

export interface Confirmations {
  /** Builds the plan for a package the last check listed; refused offline, for an unknown or unlisted package. */
  prepare(target: WingetTarget, listed: readonly UpdateItem[]): WingetPlan
  /** Spends a confirmation: the exact target it was given for, once, before it expires. */
  spend(token: string): WingetTarget
}

/** One-shot confirmations: a plan's token is bound to its exact target, expires, and is spent by the one upgrade it allows. */
export function confirmations(now: () => number = Date.now, ttlMs = 5 * 60_000): Confirmations {
  const pending = new Map<string, { target: WingetTarget; expiresAt: number }>()

  return {
    prepare(target, listed) {
      const problem = targetProblem(target)

      if (problem) throw new Error(problem)

      const item = listed.find(entry => entry.source === 'winget' && entry.id === target.id)

      if (!item) throw new Error(`${target.id} ne figure pas dans la dernière vérification`)
      if (item.available !== target.version) throw new Error(`la version proposée pour ${target.id} est ${item.available ?? 'inconnue'}, pas ${target.version}`)
      if ((item.repository ?? 'winget') !== target.source) throw new Error(`${target.id} vient de la source ${item.repository ?? 'winget'}, pas ${target.source}`)

      assertInternet(`la mise à jour de ${target.id}`)

      for (const [key, entry] of pending) if (entry.expiresAt <= now()) pending.delete(key)

      const token = randomBytes(16).toString('hex')
      const expiresAt = now() + ttlMs
      const exact = { id: target.id, version: target.version, source: target.source }

      pending.set(token, { target: exact, expiresAt })

      return { ...exact, name: item.name, current: item.current, token, command: wingetPreview(exact), expiresAt }
    },

    spend(token) {
      const entry = typeof token === 'string' ? pending.get(token) : undefined

      if (!entry) throw new Error('aucune confirmation valide pour cette mise à jour : confirmez-la d’abord')

      pending.delete(token)

      if (entry.expiresAt <= now()) throw new Error('la confirmation a expiré : confirmez de nouveau')

      return entry.target
    }
  }
}

/**
 * Runs one confirmed upgrade and reports its progress. The Internet is checked again at the moment it starts (the switch may have been
 * turned off since the confirmation). Never throws for winget's own failures: they come back as a result.
 */
export async function runWingetUpgrade(
  target: WingetTarget,
  options: { spawner?: WingetSpawner; onProgress?: (progress: WingetProgress) => void; timeoutMs?: number } = {}
): Promise<WingetResult> {
  assertInternet(`la mise à jour de ${target.id}`)

  const args = wingetUpgradeArgs(target, true)
  const spawner = options.spawner ?? realSpawner
  let output = ''
  let progress: WingetProgress | null = { id: target.id, phase: 'starting', percent: null, line: '' }

  options.onProgress?.(progress)

  return await new Promise<WingetResult>(resolve => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: WingetResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.onProgress?.({ id: target.id, phase: 'done', percent: result.outcome === 'failed' || result.outcome === 'cancelled' ? (progress?.percent ?? null) : 100, line: result.message })
      resolve(result)
    }
    let child: ReturnType<WingetSpawner>

    try {
      child = spawner(args)
    } catch (error) {
      finish(parseWingetResult(null, '', (error as Error).message))

      return
    }

    timer = setTimeout(() => {
      child.kill()
      finish({ outcome: 'failed', exitCode: null, message: 'winget n’a pas terminé à temps ; il a été arrêté.' })
    }, options.timeoutMs ?? 60 * 60_000)

    const read = (data: Buffer | string) => {
      const text = String(data)

      output = (output + text).slice(-64 * 1024)
      progress = readProgress(target.id, text, progress)
      options.onProgress?.(progress)
    }

    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('error', (error: Error) => finish(parseWingetResult(null, output, error.message)))
    child.on('close', (code: number | null) => finish(parseWingetResult(code, output)))
  })
}

/**
 * The whole confirmed path, as main runs it: the confirmation is spent (none, a spent one or an expired one refuses before anything else),
 * the control gate tiers the call (`shell.winget.upgrade`, mutate), the Internet is checked again, winget runs, and the gate's ticket
 * writes exactly one journal line saying how it ended. A refusal after the gate (Internet off) is journalled too.
 */
export async function upgradeThroughGate(
  gate: HostControlGate,
  pending: Confirmations,
  token: string,
  options: { spawner?: WingetSpawner; onProgress?: (progress: WingetProgress) => void } = {}
): Promise<{ ok: true; target: WingetTarget; result: WingetResult } | { ok: false; error: string }> {
  let target: WingetTarget

  try {
    target = pending.spend(token)
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }

  const gated = await gate.submitLocal({ client: 'ui', command: WINGET_UPGRADE_ACTION, args: { ...target }, source: 'updates' })

  if (gated.kind === 'reply') return { ok: false, error: gated.reply.error ?? 'Le shell a refusé cette mise à jour.' }

  const label = `${target.id} ${target.version} (${target.source})`

  // The switch may have been turned off since the confirmation.
  if (!internetAllowed()) {
    gated.finish({ ok: false, code: 'denied-policy', reason: `${label}: Internet off` })

    return { ok: false, error: `Internet désactivé pour Jarod : la mise à jour de ${target.id} n'est pas autorisée. Réactivez-le dans la barre du haut.` }
  }

  let result: WingetResult

  try {
    result = await runWingetUpgrade(target, options)
  } catch (error) {
    result = { outcome: 'failed', exitCode: null, message: (error as Error).message }
  }

  const ok = result.outcome === 'success' || result.outcome === 'reboot-required'

  gated.finish({ ok, reason: `${label}: ${result.outcome}${result.exitCode ? ` 0x${result.exitCode.toString(16)}` : ''}` })

  return { ok: true, target, result }
}
