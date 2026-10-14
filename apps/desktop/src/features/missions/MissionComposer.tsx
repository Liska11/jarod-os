import { IconRocket } from '@tabler/icons-react'
import { t, useT } from '../../lib/i18n.ts'
import { useState } from 'react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { startMission } from '../../store/missions-actions.ts'
import { notify } from '../../store/notifications.ts'

export function MissionComposer({ onClose }: { onClose: () => void }) {
  useT()
  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const ready = text.trim().length > 0 && !starting

  const start = async () => {
    const goal = text.trim()

    if (!goal || starting) {
      return
    }

    setStarting(true)

    try {
      await startMission(goal)
      onClose()
    } catch (error) {
      notify({ title: t('missionNew.startFailed'), body: error instanceof Error ? error.message : String(error), level: 'error' })
      setStarting(false)
    }
  }

  return (
    <div className="glass-card animate-rise flex flex-col gap-3 rounded-xl p-4">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
        <IconRocket size={16} className="text-accent-strong" />
        {t('missions.new')}
      </div>
      <textarea
        value={text}
        autoFocus
        rows={3}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void start()
          }

          if (event.key === 'Escape') {
            onClose()
          }
        }}
        placeholder={t('missionNew.goal')}
        aria-label={t('missionNew.goalAria')}
        className="glass-input w-full resize-none rounded-lg px-3 py-2.5 text-[13px] text-fg outline-none placeholder:text-fg-4"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-fg-4">{t('missionNew.hint')}</span>
        <div className="flex items-center gap-2">
          <GlassButton size="sm" variant="ghost" onClick={onClose} disabled={starting}>
            {t('controls.cancel')}
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void start()} disabled={!ready}>
            {starting ? t('missionNew.starting') : t('missionNew.start')}
          </GlassButton>
        </div>
      </div>
    </div>
  )
}
