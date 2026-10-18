import { atom } from 'nanostores'
import type { VoicePrefs } from '../../shared/ipc.ts'
import { t } from '../lib/i18n.ts'
import { ECHO_GUARD, EchoGuard } from '../lib/voice/echo-guard.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { notify } from './notifications.ts'

/*
 * The reaction to echo in duplex mode (src/lib/voice/echo-guard.ts). Once the guard trips, conversations of this app run use classic mode (mic
 * closed while Jarod speaks) and one notification says why, with two buttons: back to duplex, or keep classic for good. The saved preference is
 * not touched until the person picks one, and the switch ends with the app run: nothing changes behind their back for longer than that.
 */

/** Classic mode in force for this app run because echo was detected; the saved `voice.duplex` is unchanged. */
export const $echoFallback = atom(false)

let guard = new EchoGuard(ECHO_GUARD)

/** An interruption transcribed to no words. */
export function noteEmptyBargeIn(now: number = performance.now()): void {
  if (!guard.emptyBargeIn(now)) {
    return
  }

  $echoFallback.set(true)
  notify({
    title: t('voice.echo.title'),
    body: t('voice.echo.body', { count: ECHO_GUARD.threshold, seconds: Math.round(ECHO_GUARD.windowMs / 1000) }),
    level: 'warn',
    surface: 'chat',
    key: 'voice.echo',
    actions: [
      { label: t('voice.echo.restore'), command: 'voice.duplex.set', args: { enabled: true } },
      { label: t('voice.echo.keep'), command: 'voice.duplex.set', args: { enabled: false } }
    ]
  })
}

/** An interruption that held real words. */
export function noteHeardBargeIn(): void {
  guard.heardBargeIn()
}

/** Whether the mic stays open while Jarod speaks: the saved choice, unless echo switched this run to classic. */
export function isDuplexActive(prefs: VoicePrefs): boolean {
  return prefs.duplex !== false && !$echoFallback.get()
}

/** The person's explicit choice (notification button, Settings, voice command): saved, and it ends the temporary switch. Never re-prompts. */
export async function setDuplex(enabled: boolean): Promise<void> {
  $echoFallback.set(false)
  await updatePrefs({ voice: { ...$prefs.get().voice, duplex: enabled } })
}

/** Tests only: a fresh guard and no switch. */
export function resetEchoGuard(): void {
  guard = new EchoGuard(ECHO_GUARD)
  $echoFallback.set(false)
}
