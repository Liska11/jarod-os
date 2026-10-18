/** Backups on the Jarod disk, as the renderer sees them (electron/backups.ts). */

export interface BackupInfo {
  id: string
  created: string
  reason: 'manual' | 'daily' | 'before-restore'
  parts: Array<'data' | 'workspace'>
  files: number
  bytes: number
  linked: number
}

export interface BackupsState {
  /** Backups need the Jarod disk (Settings › Storage). */
  available: boolean
  folder: string | null
  daily: boolean
  keep: number
  running: boolean
  list: BackupInfo[]
}

export type BackupActionResult = { ok: true; id?: string } | { ok: false; error: string }
