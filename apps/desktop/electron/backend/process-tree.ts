import { type ChildProcess, execFile, execFileSync } from 'node:child_process'

/**
 * Stop a child and everything it started. POSIX signals do not exist on Windows, and the venv's
 * `python.exe` is a launcher that starts the real interpreter as a child, so `child.kill()` would
 * leave the backend running; `taskkill /T` takes the whole tree.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined)

    return
  }

  child.kill(signal)
}

/** The parent of `pid` on Windows, or null (a PowerShell call: only used to classify a foreign gateway). */
export function windowsParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }

  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`], { encoding: 'utf8', timeout: 5000, windowsHide: true })

  return Number(out.trim()) || null
}
