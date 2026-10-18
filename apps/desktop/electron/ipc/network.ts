import { app, BrowserWindow, ipcMain, session, type Session, type WebContents, webContents } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { NetworkPolicy } from '../../shared/network-policy.ts'
import { log } from '../log.ts'
import type { NetworkPolicyService, NetworkSessions, ProxyChoice } from '../network.ts'

/*
 * The Internet switch in the running shell: every web session (the shell's, the sites of the right pane, the viewers, the agent's browser)
 * takes the policy's proxy, and while the Internet is off, WebRTC may not send UDP outside a proxy (WebRTC ignores proxies otherwise).
 * The setting is changed only from the shell's own UI: nothing the agent can call turns the Internet back on.
 */

const sessions = new Set<Session>()
let current: ProxyChoice = { mode: 'system' }
/** Each web page's WebRTC policy before the switch went off, put back when it comes on again. */
const webrtcBefore = new WeakMap<WebContents, string>()

async function applyTo(ses: Session, choice: ProxyChoice, cut: boolean): Promise<void> {
  try {
    await ses.setProxy(choice.mode === 'system' ? { mode: 'system' } : { mode: 'fixed_servers', proxyRules: choice.proxyRules, proxyBypassRules: choice.proxyBypassRules })

    if (cut) {
      await ses.closeAllConnections()
    }
  } catch (error) {
    log('network', `proxy not applied to a session: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function applyWebRtc(contents: WebContents, offline: boolean): void {
  if (contents.isDestroyed()) return

  try {
    if (offline) {
      if (!webrtcBefore.has(contents)) webrtcBefore.set(contents, contents.getWebRTCIPHandlingPolicy())
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    } else if (webrtcBefore.has(contents)) {
      contents.setWebRTCIPHandlingPolicy(webrtcBefore.get(contents) as Parameters<WebContents['setWebRTCIPHandlingPolicy']>[0])
      webrtcBefore.delete(contents)
    }
  } catch {
    // A page closing at that moment.
  }
}

/** The Electron side of NetworkSessions; call before the app is ready so no session is created unseen. */
export function electronNetworkSessions(): NetworkSessions {
  app.on('session-created', ses => {
    sessions.add(ses)
    void applyTo(ses, current, false)
  })
  app.on('web-contents-created', (_event, contents) => applyWebRtc(contents, current.mode !== 'system'))

  return {
    async apply(choice, cut) {
      current = choice

      if (app.isReady()) {
        sessions.add(session.defaultSession)
      }

      await Promise.all([...sessions].map(ses => applyTo(ses, choice, cut)))

      for (const contents of webContents.getAllWebContents()) {
        applyWebRtc(contents, choice.mode !== 'system')
      }
    }
  }
}

export function registerNetworkIpc(service: NetworkPolicyService): void {
  ipcMain.handle(IPC.networkGet, (): NetworkPolicy => service.get())
  ipcMain.handle(IPC.networkSet, async (_event, change: unknown): Promise<NetworkPolicy> => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      throw new Error('réglage réseau attendu')
    }

    const next = await service.set(change as Partial<NetworkPolicy>)
    log('network', `Internet ${next.internet ? 'on' : 'off'}${next.internet ? '' : `, remote machines ${next.remoteMachines ? 'allowed' : 'blocked'}, local commands ${next.localCommands ? 'allowed' : 'blocked'}`}`)

    return next
  })
  service.onChange(policy => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.networkChanged, policy)
    }
  })
}
