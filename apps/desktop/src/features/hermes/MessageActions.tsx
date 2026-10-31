import { IconCheck, IconCopy } from '@tabler/icons-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { copyText } from '../../lib/clipboard.ts'
import { useT } from '../../lib/i18n.ts'

/** A small icon button under a message; visible on hover and on keyboard focus so a long transcript stays quiet. */
export function MessageAction({ label, onClick, children, className }: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={cn('flex size-5 items-center justify-center rounded text-fg-4 hover:bg-white/10 hover:text-fg focus-visible:text-fg', className)}>
      {children}
    </button>
  )
}

/** Copies `text`; the icon turns into a tick for a moment so the click is seen to have worked. */
export function CopyAction({ text, label, className, size = 13 }: { text: string; label?: string; className?: string; size?: number }) {
  const { t } = useT()
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = () => {
    void copyText(text).then(ok => {
      if (!ok) {
        return
      }

      setDone(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setDone(false), 1500)
    })
  }

  return (
    <MessageAction label={done ? t('chat.copied') : (label ?? t('chat.copy'))} onClick={copy} className={className}>
      {done ? <IconCheck size={size} /> : <IconCopy size={size} />}
    </MessageAction>
  )
}
