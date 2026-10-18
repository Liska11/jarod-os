import { atom } from 'nanostores'
import { MESSAGING_APPS, type MessagingApp } from '../../../shared/web-sites.ts'
import { showPage } from '../../store/windows.ts'

const STORE_KEY = 'jarod.messaging.app'

function initial(): MessagingApp {
  try {
    const saved = localStorage.getItem(STORE_KEY)

    return MESSAGING_APPS.find(app => app === saved) ?? MESSAGING_APPS[0]
  } catch {
    return MESSAGING_APPS[0]
  }
}

/** The messaging app the Messaging page shows (picked in the sidebar's Messaging section). */
export const $messagingApp = atom<MessagingApp>(initial())

export function showMessaging(app: MessagingApp): void {
  $messagingApp.set(app)

  try {
    localStorage.setItem(STORE_KEY, app)
  } catch {
    // A convenience only: without storage the page opens on Telegram.
  }

  showPage('messaging')
}
