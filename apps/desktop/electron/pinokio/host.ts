import http from 'node:http'
import path from 'node:path'
import { checkRequest } from './guard.ts'
import { type HostMessage, type ParentMessage, PINOKIO_PORT } from './protocol.ts'

/*
 * The child process that runs the Pinokio engine (pinokiod, MIT, https://github.com/pinokiocomputer/pinokiod) for
 * Jarod-OS. scripts/bundle-pinokio.mjs compiles this file to `host.cjs` beside pinokiod's node_modules; main starts it
 * with Jarod-OS's own executable in Node mode (service.ts) and talks to it over the IPC channel.
 *
 * pinokiod is used unmodified. Two things are added around it, before it is loaded:
 * - every HTTP server it creates without an address listens on loopback only (upstream: every interface), unless
 *   JAROD_PINOKIO_LAN=1 (the user chose to share with the network, which pinokiod's own settings then manage);
 * - every request and WebSocket upgrade to those servers passes guard.ts first (Host and Origin must be this machine).
 *
 * Its own quit/restart/open-a-page callbacks become messages to main, and main's `stop` runs its shutdown, which stops
 * the apps it started (their whole process trees) and then this process.
 */

const send = (message: HostMessage): void => {
  if (process.send) {
    process.send(message)
  }
}

const lan = process.env.JAROD_PINOKIO_LAN === '1'
const guarded = new WeakSet<http.Server>()

function guard(server: http.Server): void {
  if (guarded.has(server)) {
    return
  }

  guarded.add(server)
  const emit = server.emit.bind(server) as (event: string | symbol, ...args: unknown[]) => boolean

  server.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event === 'request' || event === 'upgrade') {
      const request = args[0] as http.IncomingMessage
      const verdict = checkRequest({ method: request.method, host: request.headers.host, origin: request.headers.origin })

      if (!verdict.ok) {
        console.warn(`[jarod-os] refused ${request.method} ${request.url}: ${verdict.reason}`)

        if (event === 'request') {
          const response = args[1] as http.ServerResponse
          response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          response.end('Refused by Jarod-OS: this engine only answers this computer.\n')
        } else {
          const socket = args[1] as import('node:net').Socket
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
        }

        return true
      }
    }

    return emit(event, ...args)
  }) as typeof server.emit
}

const listen = http.Server.prototype.listen

http.Server.prototype.listen = function patchedListen(this: http.Server, ...args: unknown[]) {
  if (!lan) {
    if (typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) {
      if (typeof args[1] !== 'string') {
        args.splice(1, 0, '127.0.0.1')
      }
    } else if (args[0] && typeof args[0] === 'object' && !(args[0] as { host?: string }).host && (args[0] as { port?: unknown }).port !== undefined) {
      args[0] = { ...(args[0] as object), host: '127.0.0.1' }
    }
  }

  guard(this)

  return (listen as (...a: unknown[]) => http.Server).apply(this, args)
} as typeof http.Server.prototype.listen

interface PinokioServer {
  port: number
  version: { pinokiod: string; pinokio: string }
  kernel: { homedir?: string }
  start(options: Record<string, unknown>): Promise<void>
  shutdown(label: string): void
}

const version = process.env.JAROD_PINOKIO_VERSION || '8.2.2'
const Server = require(path.join(__dirname, 'node_modules', 'pinokiod')) as new (config: Record<string, unknown>) => PinokioServer

const server = new Server({
  agent: 'web',
  version,
  site: 'https://pinokio.co',
  discover_dark: 'https://pinokio.co?embed=1&theme=dark',
  discover_light: 'https://pinokio.co?embed=1&theme=light',
  portal: 'https://pinokio.co',
  docs: 'https://pinokio.co/docs',
  install: 'https://pinokiocomputer.github.io/program.pinokio.computer/#/?id=install',
  newsfeed: (uri: string) => `https://pinokiocomputer.github.io/home/item?uri=${uri}&display=feed`,
  profile: (uri: string) => `https://pinokiocomputer.github.io/home/item?uri=${uri}&display=profile`,
  // Copied to ~/.pinokio/config.json only when that file does not exist yet; pinokiod's first-run screen then asks for a home folder.
  store: { store: {} }
})

let stopping = false

function stop(label: string): void {
  if (stopping) {
    return
  }

  stopping = true
  // Belt and braces: shutdown() ends with killing this process tree; if it does not, leave anyway.
  setTimeout(() => process.exit(0), 8_000).unref()

  try {
    server.shutdown(label)
  } catch (error) {
    console.error('[jarod-os] pinokiod shutdown failed', error)
    process.exit(0)
  }
}

process.on('message', (message: ParentMessage) => {
  if (message && message.type === 'stop') {
    stop('Jarod-OS')
  }
})

// Jarod-OS went away without saying goodbye (crash, killed): do not leave AI apps running with nobody to stop them.
process.on('disconnect', () => stop('Jarod-OS disconnected'))

server
  .start({
    onquit: () => send({ type: 'quit' }),
    onrestart: () => send({ type: 'restart' }),
    browser: {
      open: async (payload: { url?: unknown; surface?: unknown } = {}) => {
        const url = typeof payload.url === 'string' ? payload.url.trim() : ''

        if (!url) {
          return { ok: false, error: 'missing-url', surface_used: 'browser' }
        }

        send({ type: 'open', url, surface: payload.surface === 'browser' ? 'browser' : 'window' })

        return { ok: true, surface_used: payload.surface === 'browser' ? 'browser' : 'popup' }
      }
    }
  })
  .then(
    () => send({ type: 'ready', port: server.port ?? PINOKIO_PORT, version: server.version?.pinokiod ?? version, home: server.kernel?.homedir ?? null }),
    (error: unknown) => {
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
      process.exit(1)
    }
  )
