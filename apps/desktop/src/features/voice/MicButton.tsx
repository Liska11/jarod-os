import { useStore } from '@nanostores/react'
import { IconMicrophone } from '@tabler/icons-react'
import { useEffect, useMemo } from 'react'
import { cn } from '../../lib/cn.ts'
import { $dictation, finishDictation, startDictation } from '../../store/dictation.ts'
import { isMainSurface, relayToMain } from '../../store/shell.ts'
import { $voiceActive, toggleVoice } from '../../store/voice.ts'
import { createDoublePress } from './double-press.ts'

/**
 * The composers' microphone. One press starts (or ends) a spoken conversation with Hermes. Two quick presses dictate into the chat box: what
 * you say is transcribed and put there, and you press Send yourself (as in the Claude app). While dictating, a press ends it.
 */
export function MicButton({ size = 17, className, disabled }: { size?: number; className?: string; disabled?: boolean }) {
  const active = useStore($voiceActive)
  const dictating = useStore($dictation).phase !== 'idle'
  const label = dictating ? 'Finish dictation' : active ? 'End voice conversation' : 'Talk to Hermes (double-press to dictate)'
  const presses = useMemo(
    () =>
      createDoublePress(
        () => {
          if (isMainSurface) {
            void toggleVoice('button')
          } else {
            // Overlay windows (panels mode) hand the conversation to the Hermes window.
            relayToMain({ type: 'voice', args: ['toggle'] })
          }
        },
        () => {
          if (isMainSurface) {
            void startDictation({ into: 'composer' })
          } else {
            relayToMain({ type: 'dictate' })
          }
        }
      ),
    []
  )

  useEffect(() => () => presses.cancel(), [presses])

  const onClick = () => {
    // Dictating: one press finishes it at once (no waiting to tell a double press).
    if ($dictation.get().phase === 'listening') {
      presses.cancel()
      void finishDictation()

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
