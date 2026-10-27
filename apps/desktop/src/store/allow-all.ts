import { atom } from 'nanostores'
import { jarod } from '../lib/jarod.ts'

/*
 * « Tout autoriser » : l'état du bouton global, réversible, pour les demandes qui enchaînent plusieurs appels.
 *
 * Côté moteur, c'est le profil « Personnalisé » avec l'interrupteur « sans demander » — la seule combinaison où les limites dures
 * (`run_shell`, `system_files`, `web_fetch`…) ne demandent plus. Le canal `tools-allow-all` fait le changement d'un bloc, avec une
 * confirmation native à l'allumage seulement. Le profil d'avant est retenu ici (localStorage) pour qu'« éteindre » le rende tel quel.
 */

export interface AllowAllState {
  on: boolean
  busy: boolean
}

export const $allowAll = atom<AllowAllState>({ on: false, busy: false })

const PREVIOUS_PROFILE_KEY = 'jarod-os.allow-all.profile'

interface JarodSettingsLike {
  accessProfile?: string
  autoApproveTools?: boolean
}

const readable = (value: string | null): string | null => (value === 'ask' || value === 'approve' || value === 'full' || value === 'custom' ? value : null)

const remember = (profile: string | undefined): void => {
  if (!profile || profile === 'custom') {
    return
  }

  try {
    localStorage.setItem(PREVIOUS_PROFILE_KEY, profile)
  } catch {
    // stockage refusé : « éteindre » retombera sur « Plein »
  }
}

const previousProfile = (): string => {
  try {
    return readable(localStorage.getItem(PREVIOUS_PROFILE_KEY)) ?? 'full'
  } catch {
    return 'full'
  }
}

/** Relit l'état réel du moteur (au démarrage, et après un changement fait ailleurs). */
export async function loadAllowAll(): Promise<void> {
  try {
    const settings = await jarod<JarodSettingsLike>('get-jarod-settings')
    $allowAll.set({ ...$allowAll.get(), on: settings.accessProfile === 'custom' && settings.autoApproveTools === true })
  } catch {
    // moteur pas encore prêt : le bouton reste « éteint » et réessaiera au clic
  }
}

/** Allume ou éteint. Lève l'erreur du moteur (refus dans la confirmation native, canal indisponible). */
export async function setAllowAll(on: boolean): Promise<boolean> {
  if ($allowAll.get().busy) {
    return false
  }

  $allowAll.set({ ...$allowAll.get(), busy: true })

  try {
    if (on) {
      remember((await jarod<JarodSettingsLike>('get-jarod-settings')).accessProfile)
    }

    await jarod('tools-allow-all', on, previousProfile())
    $allowAll.set({ on, busy: false })

    return true
  } catch (error) {
    $allowAll.set({ ...$allowAll.get(), busy: false })
    throw error
  }
}
