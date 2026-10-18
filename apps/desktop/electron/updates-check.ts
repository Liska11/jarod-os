import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-write.ts'

/*
 * Checking for updates (docs/UPDATES.md), read-only. Windows and drivers: the Windows Update Agent API (Microsoft.Update.Session), whose
 * search installs nothing. Software: `winget upgrade`, which lists and installs nothing. Each category says whether it is up to date, has
 * updates, failed, is not supported here, or was not checked. Nothing is installed by the check: Windows Update opens in Windows' own
 * Settings, and one listed winget package can be upgraded after the person confirmed it (electron/winget-install.ts). Results are kept with their date and shown as old when offline.
 */

export type UpdateCategory = 'windows' | 'drivers' | 'software'
export type CategoryStatus = 'up-to-date' | 'available' | 'failed' | 'unsupported' | 'unchecked'

export interface UpdateItem {
  name: string
  /** KB number, driver model, or winget package id. */
  id: string
  current: string | null
  available: string | null
  source: 'Windows Update' | 'winget'
  /** winget: the source the package comes from (`winget`, `msstore`, …), as its Source column says. */
  repository?: string
  /** Windows Update: may ask for a restart (`RebootBehavior` 1 or 2). */
  restart: boolean
  /** Installing needs administrator rights. */
  elevation: boolean
}

export interface CategoryResult {
  status: CategoryStatus
  items: UpdateItem[]
  error?: string
}

export interface UpdatesReport {
  checkedAt: string | null
  categories: Record<UpdateCategory, CategoryResult>
  /** What this check does not cover, in words. */
  coverage: string[]
}

export const EMPTY: UpdatesReport = {
  checkedAt: null,
  categories: { windows: { status: 'unchecked', items: [] }, drivers: { status: 'unchecked', items: [] }, software: { status: 'unchecked', items: [] } },
  coverage: []
}

export const COVERAGE = [
  'Pilotes : seulement ceux que Windows Update propose ; les outils des fabricants (OEM) et les pilotes graphiques installés à part ne sont pas vus.',
  'Logiciels : seulement ceux que winget reconnaît ; les applications du Microsoft Store et les logiciels installés autrement peuvent manquer.',
  'Le Microsoft Store et Jarod-OS lui-même ne sont pas vérifiés ici.'
]

/** The Windows Update search: not installed, not hidden; type 1 software, type 2 driver. */
export const WU_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$session = New-Object -ComObject Microsoft.Update.Session',
  '$searcher = $session.CreateUpdateSearcher()',
  '$result = $searcher.Search("IsInstalled=0 and IsHidden=0")',
  '@($result.Updates | ForEach-Object { [pscustomobject]@{ Title = [string]$_.Title; Type = [int]$_.Type; KB = (@($_.KBArticleIDs) -join ","); Reboot = [int]$_.InstallationBehavior.RebootBehavior;',
  '  Model = $(if ($_.Type -eq 2) { [string]$_.DriverModel } else { "" }); Maker = $(if ($_.Type -eq 2) { [string]$_.DriverManufacturer } else { "" }); Date = $(if ($_.Type -eq 2) { [string]$_.DriverVerDate } else { "" }) } }) | ConvertTo-Json -Compress'
].join('\n')

export function parseWindowsUpdate(json: string): { windows: UpdateItem[]; drivers: UpdateItem[] } {
  const text = json.trim()
  const rows = text ? (JSON.parse(text) as unknown) : []
  const list = (Array.isArray(rows) ? rows : [rows]) as Array<{ Title?: string; Type?: number; KB?: string; Reboot?: number; Model?: string; Maker?: string; Date?: string }>
  const windows: UpdateItem[] = []
  const drivers: UpdateItem[] = []

  for (const row of list) {
    if (!row || typeof row.Title !== 'string') continue

    const item: UpdateItem = {
      name: row.Title,
      id: row.Type === 2 ? [row.Maker, row.Model].filter(Boolean).join(' ') || row.Title : row.KB ? `KB${row.KB.split(',')[0]}` : row.Title,
      current: null,
      available: row.Type === 2 ? (row.Date ?? '').replace(/\s+00:00:00$/, '') || null : null,
      source: 'Windows Update',
      restart: row.Reboot === 1 || row.Reboot === 2,
      elevation: true
    }

    ;(row.Type === 2 ? drivers : windows).push(item)
  }

  return { windows, drivers }
}

/**
 * `winget upgrade` prints a table whose headers follow the system's language: the columns are found from the header's word positions
 * (Name, Id, Version, Available, Source), the rows cut at those positions. The summary line after the rows is ignored.
 */
export function parseWinget(output: string): UpdateItem[] {
  const lines = output.replace(/\r/g, '').split('\n')
  const rule = lines.findIndex(line => /^-{20,}\s*$/.test(line.trim()))

  if (rule < 1) return []

  const header = lines[rule - 1]
  const starts = [...header.matchAll(/\S+/g)].map(match => match.index ?? 0)

  if (starts.length < 4) return []

  const cell = (line: string, index: number) => line.slice(starts[index], index + 1 < starts.length ? starts[index + 1] : undefined).trim()
  const items: UpdateItem[] = []

  for (const line of lines.slice(rule + 1)) {
    if (!line.trim() || line.length <= starts[3]) continue

    const id = cell(line, 1)

    if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(id)) continue
    const repository = (starts.length > 4 ? cell(line, 4) : '') || 'winget'

    items.push({ name: cell(line, 0), id, current: cell(line, 2) || null, available: cell(line, 3) || null, source: 'winget', repository, restart: false, elevation: false })
  }

  return items
}

export const WINGET_ID = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/

const run = (file: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; error: string }> =>
  new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), error: error ? (String(stderr).trim() || error.message).split(/\r?\n/).slice(-2).join(' · ').slice(0, 300) : '' })
    })
  })

export async function checkWindowsUpdate(): Promise<{ windows: CategoryResult; drivers: CategoryResult }> {
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WU_SCRIPT], 10 * 60_000)

  if (!result.ok) {
    const failed: CategoryResult = { status: 'failed', items: [], error: result.error }

    return { windows: failed, drivers: failed }
  }

  try {
    const { windows, drivers } = parseWindowsUpdate(result.stdout)

    return { windows: { status: windows.length ? 'available' : 'up-to-date', items: windows }, drivers: { status: drivers.length ? 'available' : 'up-to-date', items: drivers } }
  } catch (error) {
    const failed: CategoryResult = { status: 'failed', items: [], error: (error as Error).message }

    return { windows: failed, drivers: failed }
  }
}

export async function checkWinget(): Promise<CategoryResult> {
  const result = await run('winget', ['upgrade', '--include-unknown', '--disable-interactivity'], 5 * 60_000)

  if (!result.ok && /ENOENT|not recognized|introuvable/i.test(result.error)) return { status: 'unsupported', items: [], error: 'winget n’est pas installé' }

  const items = parseWinget(result.stdout)

  if (!result.ok && items.length === 0) return { status: 'failed', items: [], error: result.error }

  return { status: items.length ? 'available' : 'up-to-date', items }
}

export function readReport(file: string): UpdatesReport {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as UpdatesReport

    return raw?.categories ? raw : { ...EMPTY }
  } catch {
    return { ...EMPTY }
  }
}

export function writeReport(file: string, report: UpdatesReport): void {
  writeFileAtomic(file, `${JSON.stringify(report, null, 2)}\n`)
}

export const REPORT_FILE = (configDir: string) => path.join(configDir, 'updates-check.json')
