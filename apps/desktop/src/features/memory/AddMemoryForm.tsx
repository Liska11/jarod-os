import { useState } from 'react'
import { Chips, GlassButton, GlassCard } from '../../components/ui/glass.tsx'
import { useT } from '../../lib/i18n.ts'
import { FILE_LABEL, MEMORY_FILES, type MemoryFile } from './memory-store.ts'

/** Inline glass form at the top of the list; appends one entry to the chosen file. */
export function AddMemoryForm({ onSave, onCancel, busy }: { onSave: (file: MemoryFile, text: string) => void; onCancel: () => void; busy?: boolean }) {
  const { t } = useT()
  const fileChips = MEMORY_FILES.map(f => ({ id: f, label: t(FILE_LABEL[f]) }))
  const [text, setText] = useState('')
  const [file, setFile] = useState<MemoryFile>('MEMORY.md')
  const canSave = text.trim().length > 0 && !busy

  const save = () => {
    if (canSave) {
      onSave(file, text)
    }
  }

  return (
    <GlassCard className="flex flex-col gap-3 p-4 animate-rise">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[14px] font-semibold text-fg">{t('memoryAdd.title')}</div>
        <span className="text-[12px] text-fg-3">{file}</span>
      </div>
      <textarea
        autoFocus
        aria-label={t('memoryAdd.textAria')}
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            save()
          } else if (event.key === 'Escape') {
            onCancel()
          }
        }}
        placeholder={t('memoryAdd.placeholder')}
        rows={3}
        className="glass-input selectable w-full resize-y rounded-lg px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-4"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chips items={fileChips} value={file} onChange={setFile} />
        <div className="flex items-center gap-2">
          <GlassButton size="sm" onClick={onCancel}>
            {t('controls.cancel')}
          </GlassButton>
          <GlassButton size="sm" variant="primary" disabled={!canSave} onClick={save}>
            {t('controls.save')}
          </GlassButton>
        </div>
      </div>
    </GlassCard>
  )
}
