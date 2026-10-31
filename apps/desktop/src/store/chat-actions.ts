import { chatToMarkdown, exportFileName } from '../lib/chat-export.ts'
import { downloadText } from '../lib/clipboard.ts'
import { fromTranscript } from '../lib/chat-model.ts'
import { $assistantName, t } from '../lib/i18n.ts'
import { $chats, SESSION_SOURCE } from './chat.ts'
import { gatewayRequest } from './gateway.ts'
import { notify } from './notifications.ts'
import { $sessions, renameSession } from './sessions.ts'

/* What the person does to a whole conversation from the rail or the menu: give it a name, save it as a file. */

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Gives a conversation the title the person chose: the core keeps it, then the open chat and the rail show it. An empty title changes nothing. */
export async function renameChat(storedId: string, title: string): Promise<void> {
  const next = title.trim()

  if (!next) {
    return
  }

  const kept = await renameSession(storedId, next)
  const live = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId)

  if (live) {
    $chats.setKey(live.sessionId, { ...live, title: kept, info: { ...live.info, title: kept } })
  }
}

/** Saves a conversation as a Markdown file (the system asks where). An open chat is exported as it is; any other is read from the core first. */
export async function exportConversation(storedId: string): Promise<void> {
  try {
    const live = Object.values($chats.get()).find(chat => chat.storedSessionId === storedId)
    let messages = live?.messages ?? []
    let title = live?.title || $sessions.get().find(row => row.id === storedId)?.title || ''

    if (messages.length === 0) {
      const result = await gatewayRequest('session.resume', { session_id: storedId, source: SESSION_SOURCE })
      messages = fromTranscript(result.messages ?? [])
      title = result.info?.title || title
    }

    if (!messages.some(message => message.role !== 'tool' && message.role !== 'system')) {
      notify({ title: t('chat.exportEmpty'), level: 'info', surface: 'hermes' })

      return
    }

    const now = Date.now()
    const markdown = chatToMarkdown(title, messages, {
      you: t('chat.export.you'),
      assistant: $assistantName.get(),
      tool: t('chat.export.tool'),
      exportedOn: t('chat.export.on', { date: new Date(now).toLocaleString() }),
      untitled: t('sidebar.untitled')
    })
    const name = exportFileName(title, now)
    downloadText(name, markdown)
    notify({ title: t('chat.exported'), body: name, level: 'success', surface: 'hermes' })
  } catch (error) {
    notify({ title: t('chat.exportFailed'), body: errorText(error), level: 'error', surface: 'hermes' })
  }
}
