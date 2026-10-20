import { $prefs, updatePrefs } from './backend.ts'
import { $activeChat, $activeChatId, $chats, createChat, interruptChat, openStoredSession, runSlash, sendPrompt } from './chat.ts'
import { $connection, gatewayRequest } from './gateway.ts'
import { $hermesAuth, requestHermesLogin } from './hermes-auth.ts'
import { $notifications } from './notifications.ts'
import { $pendingRequests, resolveRequest } from './requests.ts'
import { $sessions } from './sessions.ts'
import { openAsk, showSurface } from './surface.ts'
import { matchIntent } from '../lib/voice/intents.ts'
import { $commandLog, type CommandSource, listCommands, runCommand } from './os-commands.ts'
import { $voice, endConversation, runVoiceIntent, speakWithFreeFallback, startVoice, toggleMute } from './voice.ts'
import { $studios, openStudio, setPreview } from './studio.ts'
import { startBuild } from './studio-actions.ts'
import { $wake } from './wake.ts'
import { $webWindows, closeWebWindow, openWebWindow } from './web-windows.ts'
import { $page, $windows, openApp, showPage } from './windows.ts'

/** Installed only in development builds (see boot.ts). */
export function installDebugHook(): void {
  Object.assign(window as unknown as Record<string, unknown>, {
    __jarodOS: {
      sendPrompt,
      runSlash,
      createChat,
      openStoredSession,
      interruptChat,
      gatewayRequest,
      showSurface,
      openAsk,
      showPage,
      openApp,
      resolveRequest,
      prefs: { get: () => $prefs.get(), update: updatePrefs },
      os: {
        run: (id: string, args?: Record<string, unknown>, source: CommandSource = 'cli') => runCommand(id, args ?? {}, { source }),
        list: () => listCommands({ includeHidden: true }),
        match: matchIntent,
        intent: runVoiceIntent,
        log: () => $commandLog.get()
      },
      auth: { request: requestHermesLogin, state: () => $hermesAuth.get() },
      web: { open: openWebWindow, close: closeWebWindow, state: () => $webWindows.get() },
      studio: { open: openStudio, build: startBuild, preview: setPreview, state: () => $studios.get() },
      voice: {
        start: startVoice,
        end: endConversation,
        toggleMute,
        speakFree: speakWithFreeFallback,
        state: () => ({ ...$voice.get(), wake: $wake.get() }),
        // Audio helpers for automated runs (speak a line, exercise the speak-stream socket).
        lib: () => import('../lib/voice/speak-stream.ts'),
        capture: () => import('../lib/voice/audio-capture.ts')
      },
      state: () => ({
        connection: $connection.get(),
        page: $page.get(),
        windows: Object.values($windows.get()).map(w => ({ id: w.id, appId: w.appId, phase: w.phase, bounds: w.bounds, maximized: w.maximized })),
        activeChatId: $activeChatId.get(),
        activeChat: $activeChat.get(),
        chats: $chats.get(),
        sessions: $sessions.get(),
        pending: $pendingRequests.get().map(p => ({ kind: p.kind, id: p.request.id, params: p.request.params })),
        notifications: $notifications.get(),
        voice: $voice.get()
      })
    }
  })
}
