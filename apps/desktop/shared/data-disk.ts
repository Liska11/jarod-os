/** The Jarod disk as the renderer sees it (electron/data-root.ts, electron/data-disk.ts). */

export type DataDiskState = (
  | { kind: 'default' }
  | { kind: 'root'; root: string }
  | { kind: 'missing'; root: string }
  | { kind: 'environment' }
) & {
  /** Where the core's data and the workspace are now. */
  dataDir: string
  workspace: string
}

export type DriveWarning = 'system' | 'removable' | 'network' | 'fat' | 'lowSpace'

export interface DriveInfo {
  letter: string
  label: string
  fileSystem: string
  free: number
  size: number
  kind: 'fixed' | 'removable' | 'network' | 'other'
  system: boolean
  warnings: DriveWarning[]
  suggestedRoot: string
}

export type DataDiskApplyResult =
  | { ok: true; root: string; adopted: boolean; copied: { files: number; bytes: number }; oldCopies: string[] }
  /** not-absolute, system-folder, overlaps-current, occupied, busy, or the reason a copy failed. */
  | { ok: false; error: string }
