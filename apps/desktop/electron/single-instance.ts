import type { App } from 'electron'

/**
 * Whether this process is the Jarod-OS that runs. A second launch exits on the spot: `app.quit()` would
 * let it go on to `whenReady`, migrate data, open its own control server and, on quitting, unlink the
 * first instance's socket. The first instance hears about it through `second-instance`.
 */
export function claimSingleInstance(app: Pick<App, 'requestSingleInstanceLock' | 'exit'>): boolean {
  if (app.requestSingleInstanceLock()) {
    return true
  }

  app.exit(0)

  return false
}
