/* External backups (docs/BACKUP-EXTERNE.md): types shared by main and the renderer. */

export type ExternalPart = 'data' | 'workspace' | 'config' | 'environments' | 'sandboxes' | 'vms'

/** The parts backed up by default; the others are opt-in. */
export const DEFAULT_PARTS: ExternalPart[] = ['data', 'workspace', 'config']
export const OPTIONAL_PARTS: ExternalPart[] = ['environments', 'sandboxes', 'vms']

export interface ExternalDestination {
  /** The folder chosen (the backups go to <path>\Jarod-OS-Backups). */
  path: string
  /** The volume's unique id when it was chosen: a drive letter alone is not trusted. */
  volumeId: string | null
  label: string
}

export interface ExternalSettings {
  destination: ExternalDestination | null
  parts: ExternalPart[]
  auto: { enabled: boolean; everyHours: number }
}

export interface ExternalFileEntry {
  /** Relative to the backup folder, with forward slashes. */
  path: string
  size: number
  sha256: string
}

export interface ExternalManifest {
  format: 1
  app: string
  id: string
  instance: string
  created: string
  reason: 'manual' | 'auto'
  status: 'complete'
  parts: ExternalPart[]
  /** What was deliberately left out, in words, with the reason. */
  excluded: string[]
  /** How many secret values were removed from the database copies. */
  secretsRemoved: number
  files: ExternalFileEntry[]
  bytes: number
}

export interface ExternalBackupSummary {
  id: string
  instance: string
  created: string
  reason: 'manual' | 'auto'
  parts: ExternalPart[]
  files: number
  bytes: number
  /** Absolute folder of the backup. */
  folder: string
}

export type ExternalPhase = 'idle' | 'measuring' | 'stopping-core' | 'copying' | 'snapshot' | 'verifying' | 'finishing' | 'staging' | 'swapping'

export interface ExternalProgress {
  operation: 'backup' | 'restore' | null
  phase: ExternalPhase
  done: number
  total: number
  current: string
}

export interface DestinationCheck {
  ok: boolean
  /** Blocking problems (keys in `externalBackup.problem.*`). */
  problems: string[]
  /** Warnings that do not block (keys in `externalBackup.warning.*`). */
  warnings: string[]
  free: number | null
  fileSystem: string | null
}

export interface ExternalState {
  settings: ExternalSettings
  instance: string
  progress: ExternalProgress
  /** Whether the chosen destination is reachable and is still the same volume. */
  destinationStatus: 'none' | 'ok' | 'absent' | 'changed'
  /** The last result, in words for the UI. */
  last: { at: string; ok: boolean; message: string; id?: string } | null
  /** Why the automatic backup did not run, when it was due. */
  deferred: string | null
  list: ExternalBackupSummary[]
}

export interface ExternalEstimate {
  bytes: number
  files: number
  excluded: string[]
}

export type ExternalResult = { ok: true; id?: string } | { ok: false; error: string }
