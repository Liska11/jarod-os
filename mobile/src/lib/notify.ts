import { LocalNotifications } from '@capacitor/local-notifications'
import { isNative } from './native.ts'

let next = 1

/** Asks once for the right to notify (Android 13+). False when refused. */
export async function allowNotifications(): Promise<boolean> {
  if (!isNative) return false
  const now = await LocalNotifications.checkPermissions()
  if (now.display === 'granted') return true
  return (await LocalNotifications.requestPermissions()).display === 'granted'
}

/**
 * A notification drawn by the phone itself: what it shows came over the encrypted channel and goes
 * nowhere else (no push service is involved).
 */
export async function notifyLocal(title: string, body: string): Promise<void> {
  if (!isNative) return
  try {
    await LocalNotifications.schedule({ notifications: [{ id: next++, title, body: body.slice(0, 200) }] })
  } catch {
    // No permission: the app shows it when opened.
  }
}
