import { spawn } from 'node:child_process'
import { RECYCLE_BIN } from '../../shared/trash.ts'

type Spawn = (command: string, args: string[], options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean }) => { once(event: 'error' | 'spawn', listener: (error?: Error) => void): unknown; unref(): void }

/**
 * Show the Recycle Bin in Explorer. Explorer answers exit code 1 even when it worked, so success is "the process started", not its exit code; a missing
 * `explorer.exe` rejects with the reason instead of vanishing.
 */
export function openRecycleBin(start: Spawn = spawn as unknown as Spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = start('explorer.exe', [RECYCLE_BIN], { detached: true, stdio: 'ignore', windowsHide: false })

    child.once('error', error => reject(new Error(`Could not open the Recycle Bin: ${error?.message ?? 'explorer.exe did not start'}`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
