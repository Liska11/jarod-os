import { IconArrowsMaximize, IconMinus } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { ChatPopout } from '../features/hermes/ChatPopout.tsx'
import { useT } from '../lib/i18n.ts'

/**
 * Le chat compact (30/10) : quand on clique sur la bulle flottante, la fenêtre de Jarod devient une petite fenêtre de conversation
 * (electron/compact-chat.ts). Cette vue remplace alors le bureau : la conversation, un bouton pour réduire (retour à la bulle), un pour agrandir.
 */
export function useCompactChat(): boolean {
  const [compact, setCompact] = useState(false)

  useEffect(() => window.jarodOS.window.onCompact(setCompact), [])

  return compact
}

export function CompactChat() {
  const { t } = useT()

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-white/10 bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/8 px-3 [-webkit-app-region:drag]">
        <span className="flex-1 truncate text-[13px] font-semibold text-fg">{t('compact.title')}</span>
        <button
          type="button"
          onClick={() => void window.jarodOS.window.minimize()}
          className="flex size-7 items-center justify-center rounded-lg text-fg-3 [-webkit-app-region:no-drag] hover:bg-white/8 hover:text-fg"
          title={t('window.minimize')}
          aria-label={t('window.minimize')}
        >
          <IconMinus size={15} />
        </button>
        <button
          type="button"
          onClick={() => void window.jarodOS.window.compactExit()}
          className="flex size-7 items-center justify-center rounded-lg text-fg-3 [-webkit-app-region:no-drag] hover:bg-white/8 hover:text-fg"
          title={t('compact.expand')}
          aria-label={t('compact.expand')}
        >
          <IconArrowsMaximize size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ChatPopout />
      </div>
    </div>
  )
}
