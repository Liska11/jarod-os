import net from 'node:net'
import { isLoopback, OfflineError } from '../shared/network-policy.ts'

/*
 * The last line of the Internet switch inside a Node process: every TCP connection this process opens goes through `net.Socket.prototype.connect`
 * (Node's fetch/undici, http, https, tls and WebSocket clients all end there). A connection the policy refuses fails like a network error, with
 * an OfflineError, before any byte leaves. Local pipes and Unix sockets (`path`) are not network and pass. Child processes are NOT covered: what
 * Jarod launches is checked where it is launched (see docs/NETWORK-POLICY.md).
 *
 * Same mechanism as `jarod-core/packages/kernel/src/network.ts`.
 */

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket

let installed: Connect | null = null
/** Open connections off this machine: closed when the policy no longer allows them (streams, keep-alive). */
const open = new Map<net.Socket, string>()

/** Closes the open connections `allowed` no longer allows; returns how many. */
export function cutDisallowed(allowed: (host: string) => boolean): number {
  let cut = 0

  for (const [socket, host] of open) {
    if (!allowed(host)) {
      open.delete(socket)
      socket.destroy(new OfflineError(`la connexion à ${host}`))
      cut++
    }
  }

  return cut
}

/** The host a `connect` call targets, or null for a local pipe / Unix socket. */
export function connectTarget(args: unknown[]): string | null {
  // net.connect() hands Socket#connect its already-normalised arguments: [options, callback].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]

  if (typeof first === 'string' && !/^\d+$/.test(first)) {
    // connect(path[, cb]): a pipe or a Unix socket (Node reads a numeric string as a port, below).
    return null
  }

  if (typeof first === 'number' || typeof first === 'string') {
    return typeof args[1] === 'string' && args[1] ? args[1] : 'localhost'
  }

  if (first && typeof first === 'object') {
    const options = first as { path?: unknown; host?: unknown }

    if (typeof options.path === 'string' && options.path) {
      return null
    }

    return typeof options.host === 'string' && options.host ? options.host : 'localhost'
  }

  return 'localhost'
}

/** Installs the guard once; `allowed(host)` is asked on every connection, so a policy change applies to the next one. */
export function installSocketGuard(allowed: (host: string) => boolean): void {
  if (installed) {
    return
  }

  const original = net.Socket.prototype.connect as unknown as Connect
  installed = original

  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const host = connectTarget(args)

    if (host !== null && !allowed(host)) {
      const error = new OfflineError(`la connexion à ${host}`)
      process.nextTick(() => this.destroy(error))

      return this
    }

    if (host !== null && !isLoopback(host)) {
      open.set(this, host)
      this.once('close', () => open.delete(this))
    }

    return original.apply(this, args)
  } as typeof net.Socket.prototype.connect
}

/** Tests only: puts the original back. */
export function uninstallSocketGuard(): void {
  if (installed) {
    net.Socket.prototype.connect = installed as unknown as typeof net.Socket.prototype.connect
    installed = null
    open.clear()
  }
}
