import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { $activeChat, openStoredSession } from '../../store/chat.ts'
import { $connection } from '../../store/gateway.ts'
import { Conversation } from './Conversation.tsx'

/** A conversation in its own floating window: the same view as the Jarod page (language, model picker, context meter), without the right pane. */
export function ChatPopout({ sessionId }: { sessionId?: string }) {
  const chat = useStore($activeChat)
  const online = useStore($connection) === 'open'

  useEffect(() => {
    if (sessionId) {
      void openStoredSession(sessionId)
    }
  }, [sessionId])

  return <Conversation chat={chat} online={online} />
}
