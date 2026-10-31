import type { Link } from '../App.tsx'
import type { JarodChannel, PushedEvent } from '../lib/channel.ts'
import { linkMode } from '../lib/diagnostics.ts'
import { assist } from '../lib/native.ts'
import type { PairedPc } from '../lib/pairing-store.ts'
import { useWorkspace } from '../state/useWorkspace.ts'
import { ChatView } from './ChatView.tsx'

interface Props {
  pc: PairedPc
  channel: JarodChannel | null
  link: Link
  subscribe: (fn: (e: PushedEvent) => void) => () => void
}

/**
 * The assistant window: the chat in a sheet over the app the owner came from. Touching the dimmed
 * part closes it, and so does the back gesture (the window has no page history of its own). The diagnostic lives in the app, so it is not offered here.
 */
export function AssistScreen({ pc, channel, link, subscribe }: Props) {
  const ws = useWorkspace({ pc, channel, subscribe })
  const mode = linkMode(channel?.base, link === 'online')
  const close = () => void assist.close()
  return (
    <>
      <div className="assist-scrim" onClick={close} aria-hidden="true" />
      <div className="assist-sheet" role="dialog" aria-modal="true" aria-label="Assistant Jarod">
        <ChatView ws={ws} pc={pc} channel={channel} link={link} mode={mode} onDiagnostic={close} />
      </div>
    </>
  )
}
