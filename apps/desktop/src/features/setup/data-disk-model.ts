import type { DriveInfo } from '../../../shared/data-disk.ts'
import type { MessageKey } from '../../lib/i18n.ts'

/** The drive to offer first: a fixed, non-system NTFS/ReFS drive with room, the largest; else any non-system one. */
export function recommendedDrive(drives: readonly DriveInfo[]): DriveInfo | null {
  const clean = drives.filter(drive => drive.warnings.length === 0)
  const pick = (list: readonly DriveInfo[]) => [...list].sort((a, b) => b.free - a.free)[0] ?? null

  return pick(clean) ?? pick(drives.filter(drive => !drive.system)) ?? null
}

const KNOWN_ERRORS = new Set(['not-absolute', 'system-folder', 'overlaps-current', 'occupied', 'busy'])

/** A failed move in the interface language: a known reason has its text, a copy failure keeps its own words. */
export function diskErrorKey(error: string): { key: MessageKey; detail?: string } {
  return KNOWN_ERRORS.has(error) ? { key: `disk.error.${error}` as MessageKey } : { key: 'disk.error.copy', detail: error }
}

/** The folder on a drive Jarod-OS goes to by default, kept when the person picks another drive after editing it. */
export function rootForDrive(drive: DriveInfo, typed: string, previous: DriveInfo | null): string {
  return !typed || (previous && typed === previous.suggestedRoot) ? drive.suggestedRoot : typed
}
