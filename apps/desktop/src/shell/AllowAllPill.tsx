import { useStore } from '@nanostores/react'
import { IconShieldCheck, IconShieldX } from '@tabler/icons-react'
import { useEffect } from 'react'
import { useT } from '../lib/i18n.ts'
import { notify } from '../store/notifications.ts'
import { $allowAll, loadAllowAll, setAllowAll } from '../store/allow-all.ts'

/**
 * Le bouton « Tout autoriser » : toujours visible, un clic pour l'allumer ou l'éteindre.
 *
 * Il existe parce qu'une demande qui enchaîne plusieurs appels obligeait à valider chaque carte, et qu'un appel suivant pouvait échouer
 * pendant qu'on répondait à la précédente. Allumer passe au profil « Personnalisé » + « sans demander » (une confirmation native, une
 * seule fois) ; éteindre rend le profil d'avant. Les règles « refuser »/« demander », l'interrupteur Internet, le mode Plan et les gardes
 * des outils continuent de s'appliquer dans les deux états — c'est écrit dans la confirmation, et l'état reste affiché ici tant qu'il dure.
 */
export function AllowAllPill({ iconOnly = false }: { iconOnly?: boolean }) {
  const state = useStore($allowAll)
  const { t } = useT()

  useEffect(() => {
    void loadAllowAll()
  }, [])

  const toggle = async (): Promise<void> => {
    try {
      await setAllowAll(!state.on)
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^.*?\[oneai\]\s*/, '')

      notify({ title: state.on ? t('allowAll.failed') : t('allowAll.refused'), body: message, level: 'info' })
    }
  }

  return (
    // Dans le pied du menu latéral, dans le flux : posée en absolu sur la fenêtre, elle recouvrait les dernières entrées du menu.
    <div className="flex shrink-0 justify-center pt-2">
      <button
        type="button"
        role="switch"
        aria-checked={state.on}
        aria-label={t('allowAll.toggle')}
        data-testid="allow-all-pill"
        data-on={state.on ? 'yes' : 'no'}
        disabled={state.busy}
        title={state.on ? t('allowAll.on.hint') : t('allowAll.off.hint')}
        onClick={() => void toggle()}
        className={`flex max-w-full items-center gap-2 rounded-full border text-[12px] backdrop-blur transition-colors ${iconOnly ? 'size-8 justify-center' : 'px-3 py-1'} ${
          state.on ? 'border-danger/50 bg-danger/15 text-danger' : 'border-hairline bg-bg/80 text-fg-3 hover:text-fg-2'
        } ${state.busy ? 'opacity-60' : ''}`}
      >
        {state.on ? <IconShieldX size={14} aria-hidden /> : <IconShieldCheck size={14} aria-hidden />}
        {!iconOnly && <span className="truncate">{state.on ? t('allowAll.on') : t('allowAll.off')}</span>}
        {!iconOnly && state.on && <span className="font-medium underline-offset-2 hover:underline">{t('allowAll.stop')}</span>}
      </button>
    </div>
  )
}
