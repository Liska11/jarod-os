import { notify } from '../store/notifications.ts'
import { t, type MessageKey } from './i18n.ts'
import { failureText } from './unavailable.ts'

/*
 * Calls to the host (open a link, show a file, restart): they can be refused (a file that is gone, a scheme that is not allowed, no program for it). Fire-and-forget
 * with `void` turned that into an unhandled rejection and a click that did nothing, with no word to the user.
 */

/** Run a user-initiated host call; a refusal becomes a notification saying what could not be done and why. Never rejects. */
/** Run a host call and report a failure with the catalogue's own wording for it (`native.failed.*`). */
export async function attempt(failure: MessageKey, call: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await call()
  } catch (error) {
    notify({ title: t(failure), body: failureText(error), level: 'error' })
  }
}

/** Run a host call nobody is waiting for (closing a view, stopping a watcher): its failure changes nothing for the user. Never rejects. */
export async function quietly(call: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await call()
  } catch {
    // nothing to tell: what was being closed is already gone
  }
}
