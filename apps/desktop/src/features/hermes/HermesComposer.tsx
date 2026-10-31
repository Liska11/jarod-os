import { IconPaperclip, IconPlayerStop, IconRoute, IconSend2 } from '@tabler/icons-react'
import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { $composerFill } from '../../store/composer-fill.ts'
import { $composerDictation } from '../../store/dictation.ts'
import { MicButton } from '../voice/MicButton.tsx'
import { t, useT } from '../../lib/i18n.ts'

/*
 * The Hermes page composer. Same behaviour as chat/Composer.tsx (Enter sends, Shift+Enter breaks
 * a line, Stop while streaming) with the mockup's chrome: paperclip, mic, blue send. Slash
 * completions are intentionally left to the classic chat surface.
 *
 * While the agent works, writing is still allowed: Enter queues the message (it leaves when the turn
 * ends) and Ctrl/Cmd+Enter steers the turn in progress (the agent reads it before its next step).
 */
export function HermesComposer({ disabled, streaming, placeholder, autoFocus, onSubmit, onSteer, onInterrupt, className }: { disabled?: boolean; streaming?: boolean; placeholder?: string; autoFocus?: boolean; onSubmit: (text: string) => void | Promise<void>; onSteer?: (text: string) => void | Promise<void>; onInterrupt?: () => void; className?: string }) {
  useT()
  const [value, setValue] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const dictated = useStore($composerDictation)
  const fill = useStore($composerFill)

  // "Edit" on a sent message: its text replaces what is in the box, ready to be changed and sent again.
  useEffect(() => {
    if (!fill) {
      return
    }

    $composerFill.set(null)
    setValue(fill.text)
    textarea.current?.focus()
  }, [fill])

  // Words dictated with a double press on the microphone: put in the box after what is already there, never sent.
  useEffect(() => {
    if (!dictated) {
      return
    }

    $composerDictation.set(null)
    setValue(current => (current && !/\s$/.test(current) ? `${current} ${dictated.text}` : `${current}${dictated.text}`))
    textarea.current?.focus()
  }, [dictated])

  useEffect(() => {
    const el = textarea.current

    if (!el) {
      return
    }

    const fit = () => {
      // A hidden page has no width: measured now, every character wraps and the box sticks at 200 px.
      if (el.clientWidth === 0) {
        return
      }

      el.style.height = '0px'
      el.style.height = `${Math.min(200, Math.max(24, el.scrollHeight))}px`
    }

    fit()
    // A width change rewraps the text (or the placeholder): measured while the page was still sliding in, the box stayed 200 px tall.
    // The refit waits for the next frame: resizing inside the observer looped it, and Chromium dropped the notification that would fix the height.
    let lastWidth = el.clientWidth
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(fit)
      }
    })
    observer.observe(el)

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [value, placeholder])

  const submit = async () => {
    const text = value.trim()

    if (!text || disabled) {
      return
    }

    setValue('')
    await onSubmit(text)
  }

  const steer = async () => {
    const text = value.trim()

    if (!text || disabled || !onSteer) {
      return
    }

    setValue('')
    await onSteer(text)
  }

  const attach = async () => {
    const paths = await window.jarodOS.fs.pickFiles({ multiple: true })

    if (paths.length === 0) {
      return
    }

    const line = t('chat.attached', { paths: paths.join(', ') })
    setValue(current => (current.trim() ? `${current.replace(/\s+$/, '')}\n${line}` : line))
    textarea.current?.focus()
  }

  return (
    <div className={cn('glass-input flex items-end gap-2 rounded-xl px-2.5 py-2', className)}>
      <button type="button" aria-label={t('chat.attach')} disabled={disabled} onClick={() => void attach()} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-40">
        <IconPaperclip size={17} stroke={1.7} />
      </button>
      <textarea
        ref={textarea}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        rows={1}
        placeholder={streaming && onSteer ? t('chat.askWhileWorking') : (placeholder ?? t('chat.ask'))}
        aria-label={t('chat.message')}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()

            // Ctrl/Cmd+Enter while the agent works: steer the turn instead of queueing.
            void (streaming && onSteer && (event.ctrlKey || event.metaKey) ? steer() : submit())
          }
        }}
        className="max-h-[200px] min-h-6 flex-1 resize-none bg-transparent py-1 text-[13.5px] leading-6 outline-none placeholder:text-fg-4 disabled:opacity-50"
      />
      <MicButton size={17} className="size-8" disabled={disabled} />
      {streaming && onInterrupt ? (
        <>
          {value.trim() && onSteer ? (
            <button type="button" aria-label={t('chat.steer')} title={t('chat.steer.hint')} disabled={disabled} onClick={() => void steer()} className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line text-fg-2 hover:bg-white/8 hover:text-fg disabled:opacity-40">
              <IconRoute size={16} stroke={1.8} />
            </button>
          ) : null}
          {value.trim() ? (
            <button type="button" aria-label={t('chat.queue.add')} title={t('chat.queue.add.hint')} disabled={disabled} onClick={() => void submit()} className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-accent-strong/60 bg-accent text-accent-fg hover:bg-accent-strong disabled:opacity-40">
              <IconSend2 size={16} stroke={1.8} />
            </button>
          ) : null}
          <button type="button" aria-label={t('chat.stop')} onClick={onInterrupt} className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25">
            <IconPlayerStop size={15} />
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={t('chat.send')}
          disabled={disabled || !value.trim()}
          onClick={() => void submit()}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-accent-strong/60 bg-accent text-accent-fg shadow-[0_4px_14px_rgba(47,125,255,.45)] transition-colors duration-120 hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
        >
          <IconSend2 size={16} stroke={1.8} />
        </button>
      )}
    </div>
  )
}
