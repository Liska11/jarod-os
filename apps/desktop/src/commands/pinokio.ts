import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isLocalPage, openPinokio, showPinokioPage, startPinokio, stopPinokio } from '../store/pinokio.ts'

/*
 * The Pinokio engine (ADR-022). The core's pinokio_* tools call `pinokio.start` through the control socket before they
 * talk to the engine; the rest is for people (palette, voice) and the agent's os_ui.
 */

const describe = (state: Awaited<ReturnType<typeof window.jarodOS.pinokio.getState>>) => ({ phase: state.phase, url: state.url, version: state.version ?? null, home: state.home, error: state.error ?? null })

export const pinokioCommands: readonly OsCommand[] = [
  {
    id: 'pinokio.open',
    title: 'Open Pinokio',
    description: 'Open the Pinokio window: install and run AI apps (image, voice, video, chat) on this computer in one click.',
    tier: 'act',
    args: [],
    phrases: ['open pinokio', 'show pinokio', 'ai apps'],
    run: () => {
      openPinokio()

      return ok('Opened Pinokio')
    }
  },
  {
    id: 'pinokio.status',
    title: 'Pinokio engine status',
    description: 'Whether the Pinokio engine runs (its own, or the Pinokio app’s), its address, version and home folder.',
    tier: 'read',
    args: [],
    run: async () => {
      const state = await window.jarodOS.pinokio.getState()

      return ok(`Pinokio engine: ${state.phase}${state.version ? ` (pinokiod ${state.version})` : ''}`, { data: describe(state) })
    }
  },
  {
    id: 'pinokio.start',
    title: 'Start the Pinokio engine',
    description: 'Start the Pinokio engine in the background (or find the Pinokio app’s) so its apps can be installed and launched; resolves with its address.',
    tier: 'act',
    args: [],
    hidden: true,
    run: async () => {
      const state = await startPinokio()

      return state.phase === 'running' || state.phase === 'external' ? ok(`Pinokio engine ready at ${state.url}`, { data: describe(state) }) : fail(state.error ?? `The Pinokio engine is ${state.phase}.`)
    }
  },
  {
    id: 'pinokio.stop',
    title: 'Stop the Pinokio engine',
    description: 'Stop the Pinokio engine Jarod-OS started, and every AI app it is running. The Pinokio app’s own engine is left alone.',
    tier: 'mutate',
    args: [],
    phrases: ['stop pinokio'],
    run: async () => {
      const state = await stopPinokio()

      return state.phase === 'external' ? fail('The Pinokio app runs this engine; close the Pinokio app to stop it.') : ok('Stopped the Pinokio engine and its apps')
    }
  },
  {
    id: 'pinokio.show',
    title: 'Show an AI app',
    description: 'Show a page served on this computer by a Pinokio app (its ready_url, e.g. http://127.0.0.1:7860) in a Jarod-OS window.',
    tier: 'act',
    args: [{ name: 'url', type: 'string', description: 'http://127.0.0.1:<port>/… or http://<app>.localhost/…', required: true }],
    hidden: true,
    run: async ({ url }) => {
      const target = String(url ?? '').trim()

      if (!isLocalPage(target)) {
        return fail('pinokio.show opens pages on this computer only (localhost, 127.0.0.1, *.localhost).')
      }

      await showPinokioPage(target)

      return ok(`Showing ${target}`)
    }
  }
]
