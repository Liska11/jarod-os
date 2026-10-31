import { addressToUrl } from '../../shared/web-sites.ts'
import { $paneApps, closePaneApp, openPaneApp, PANE_APPS } from '../features/hermes/pane-apps.ts'
import { openInBrowser } from '../features/sites/site-views.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { paneAppId } from './pane-names.ts'

/*
 * The apps in the right pane of the Hermes page — the integrated Browser (Brave Search), TikTok, Instagram, the player, MovieBox, Telegram,
 * WhatsApp, Signal — were reachable by clicking only: the agent saw `web.open` (a floating window) and answered that Jarod has no such app.
 */

export const paneCommands: readonly OsCommand[] = [
  {
    id: 'pane.open',
    title: 'Open an integrated app',
    description: `Open one of Jarod-OS's integrated apps in the right-hand pane beside the chat: ${PANE_APPS.join(', ')}. "browser" is the integrated web browser (Brave Search); give "url" to load a page or a search in it. Use this, not web.open, when the user asks for the browser, TikTok, Instagram, Telegram, WhatsApp, Signal or the player.`,
    tier: 'act',
    args: [
      { name: 'name', type: 'string', description: `App: ${PANE_APPS.join(' | ')} (also: navigateur, brave, lecteur)`, required: true },
      { name: 'url', type: 'string', description: 'For the browser only: a web address, or words to search for' }
    ],
    phrases: ['open the {name} app', 'open {name} in the side panel', 'open the browser', 'open my browser'],
    run: ({ name, url }) => {
      const id = paneAppId(String(name ?? ''))

      if (!id) {
        return fail(`No integrated app called "${String(name)}". Available: ${PANE_APPS.join(', ')}.`)
      }

      if (id === 'browser' && url) {
        const target = addressToUrl(String(url))

        if (!target) {
          return fail(`"${String(url)}" is neither a web address nor something to search for.`)
        }

        openInBrowser(target)

        return ok(`Opened the browser on ${target}`, { data: { app: id, url: target } })
      }

      openPaneApp(id as Parameters<typeof openPaneApp>[0])

      return ok(`Opened ${id} in the right-hand pane`, { data: { app: id } })
    }
  },
  {
    id: 'pane.list',
    title: 'Integrated apps open in the pane',
    description: 'Which integrated apps (browser, TikTok, Instagram, Telegram, WhatsApp, Signal, player…) are open in the right-hand pane, and which exist.',
    tier: 'read',
    args: [],
    run: () => ok(`Open: ${$paneApps.get().join(', ') || 'none'}. Available: ${PANE_APPS.join(', ')}.`, { data: { open: $paneApps.get(), available: PANE_APPS } })
  },
  {
    id: 'pane.close',
    title: 'Close an integrated app tab',
    description: 'Close an integrated app tab of the right-hand pane (its session stays signed in, hidden).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'App id', required: true }],
    run: ({ name }) => {
      const id = paneAppId(String(name ?? ''))

      if (!id) {
        return fail(`No integrated app called "${String(name)}".`)
      }

      closePaneApp(id as Parameters<typeof closePaneApp>[0])

      return ok(`Closed ${id}`)
    }
  }
]
