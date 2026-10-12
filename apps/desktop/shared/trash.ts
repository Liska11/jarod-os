/*
 * Where "Trash" opens, per platform. macOS and the freedesktop trash are folders; Windows' Recycle Bin is not a folder on disk but a shell location,
 * which only Explorer can show (`explorer shell:RecycleBinFolder`).
 */

export const RECYCLE_BIN = 'shell:RecycleBinFolder'

export function trashTarget(platform: NodeJS.Platform | 'unknown'): string {
  switch (platform) {
    case 'darwin':
      return '~/.Trash'
    case 'win32':
      return RECYCLE_BIN
    default:
      return '~/.local/share/Trash/files'
  }
}

/** The one shell location the open-path call accepts, and only on Windows (anywhere else it is just an odd file name). */
export function isRecycleBin(target: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && target === RECYCLE_BIN
}
