import { useStore } from '@nanostores/react'
import { IconMicrophone } from '@tabler/icons-react'
import { useEffect, useMemo } from 'react'
import { cn } from '../../lib/cn.ts'
import { $dictation, finishDictation, startDictation } from '../../store/dictation.ts'
import { isMainSurface, relayToMain } from '../../store/shell.ts'
import { $voiceActive, toggleVoice } from '../../store/voice.ts'
import { createDoublePress } from './double-press.ts'

/**
 * The composers' microphone. One press dictates into the chat box: what you say is transcribed and put there, and you press Send yourself (as in
 * the Claude app); a press while dictating ends it. Two quick presses start (or end) a spoken conversation with Hermes.
 */
export function MicButton({ size = 17, className, disabled }: { size?: number; className?: string; disabled?: boolean }) {
  const active = useStore($voiceActive)
  const dictating = useStore($dictation).phase !== 'idle'
  const label = dictating ? 'Finish dictation' : active ? 'End voice conversation' : 'Dictate (double-press to talk to Hermes)'
  const presses = useMemo(
    () =>
      createDoublePress(
        () => {
          if (isMainSurface) {
            void startDictation({ into: 'composer' })
          } else {
            relayToMain({ type: 'dictate' })
          }
        },
        () => {
          if (isMainSurface) {
            void toggleVoice('button')
          } else {
            // Overlay windows (panels mode) hand the conversation to the Hermes window.
            relayToMain({ type: 'voice', args: ['toggle'] })
          }
        }
      ),
    []
  )

  useEffect(() => () => presses.cancel(), [presses])

  const onClick = () => {
    // Dictating: one press finishes it at once; in a voice conversation one press ends it at once (no waiting to tell a double press).
    if ($dictation.get().phase === 'listening') {
      presses.cancel()
      void finishDictation()

      return
    }

    if ($voiceActive.get()) {
      presses.cancel()
      void toggleVoice('button')

      return
    }

    presses.press()
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || dictating}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg transition-colors duration-120 disabled:cursor-not-allowed disabled:opacity-40',
        active || dictating ? 'bg-accent-soft text-accent-strong' : 'text-fg-2 hover:bg-white/8 hover:text-fg',
        dictating && 'animate-pulse',
        className
      )}
    >
      <IconMicrophone size={size} stroke={1.7} />
    </button>
  )
}
