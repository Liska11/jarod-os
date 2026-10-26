import type { KeyValue } from './pairing-store.ts'

/**
 * Android 16 can restrict an app's access to the local network (the Wi-Fi at home) until the owner
 * grants "Nearby devices" (NEARBY_WIFI_DEVICES). `unneeded`: this Android has no such permission.
 */
export type LocalNetState = 'granted' | 'denied' | 'prompt' | 'unneeded'

const EXPLAINED = 'jarod.localNet.explained'
const REFUSED = 'jarod.localNet.refused'

const read = (store: KeyValue, key: string): boolean => {
  try {
    return store.getItem(key) === '1'
  } catch {
    return false
  }
}
const write = (store: KeyValue, key: string, on: boolean): void => {
  try {
    if (on) store.setItem(key, '1')
    else store.removeItem(key)
  } catch {
    // Storage refused: the choice lasts until the app closes.
  }
}

export const loadExplained = (store: KeyValue = localStorage): boolean => read(store, EXPLAINED)
export const saveExplained = (store: KeyValue = localStorage): void => write(store, EXPLAINED, true)

/** The owner said no to the system's question. Android itself still lets the app ask once more, so it is kept here too. */
export const loadRefused = (store: KeyValue = localStorage): boolean => read(store, REFUSED)

/** After a request: remember a refusal, forget it once granted. */
export function noteAnswer(state: LocalNetState, store: KeyValue = localStorage): void {
  write(store, REFUSED, state === 'prompt' || state === 'denied')
}

/** The explanation comes once, before the system's own question, and never after a refusal. */
export const shouldExplain = (state: LocalNetState, explained: boolean): boolean => state === 'prompt' && !explained

export interface LocalNetNote {
  title: string
  text: string
  tone: 'ok' | 'warn' | 'neutral'
  /** The buttons: ask (the system's dialog) and/or open the app's settings (where a permanent refusal is undone). */
  actions: ('ask' | 'settings')[]
}

const REFUSED_TEXT =
  'Android peut alors bloquer la connexion directe à votre PC par le Wi-Fi (réseau local). Tailscale continue de fonctionner. Pour la rétablir : Réglages de l’appli › Autorisations › Appareils à proximité.'

export function describeLocalNet(state: LocalNetState, refused = false): LocalNetNote {
  switch (state) {
    case 'granted':
      return { title: 'Réseau local autorisé', text: 'Jarod peut joindre votre PC directement par le Wi-Fi de la maison.', tone: 'ok', actions: [] }
    case 'unneeded':
      return { title: 'Réseau local : pas besoin d’accord', text: 'Cette version d’Android (avant la 13) n’a pas besoin de cette autorisation.', tone: 'ok', actions: [] }
    case 'denied':
      return { title: 'Accès au réseau local refusé', text: REFUSED_TEXT, tone: 'warn', actions: ['settings'] }
    case 'prompt':
      // Refused once: Android would still ask again, but the owner has said no, and Diagnostic says so.
      return refused
        ? { title: 'Accès au réseau local refusé', text: REFUSED_TEXT, tone: 'warn', actions: ['ask', 'settings'] }
        : { title: 'Réseau local : autorisation à donner', text: 'Android demandera votre accord pour que Jarod joigne votre PC sur le Wi-Fi de la maison.', tone: 'neutral', actions: ['ask'] }
  }
}
