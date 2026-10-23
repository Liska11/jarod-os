import dgram from 'node:dgram'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { isLoopback, OfflineError } from '../shared/network-policy.ts'

/*
 * The last line of the Internet switch inside a Node process: every TCP connection this process opens goes through `net.Socket.prototype.connect`
 * (Node's fetch/undici, http, https, tls and WebSocket clients all end there). A connection the policy refuses fails like a network error, with
 * an OfflineError, before any byte leaves. Since V-05 the resolver called directly and UDP (`dgram`) are judged by the same rule.
 * Local pipes and Unix sockets (`path`) are not network and pass. Child processes are NOT covered: what
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

  installDnsGuard(allowed)
  installDgramGuard(allowed)
}

// V-05 (2026-10-23): a name refused at `connect` is never resolved, but a DIRECT resolver call (`dns.lookup`, `dns.resolve*`,
// `dns.promises`, `Resolver`) and a UDP packet (`dgram`) used to leave. Both now follow the same rule as TCP connections.
// Same mechanism as `jarod-core/packages/kernel/src/network.ts`.

type AnyFn = (...args: unknown[]) => unknown

/** What was replaced, to put it back (tests). */
const patched: { target: Record<string, unknown>; key: string; fn: unknown }[] = []

function patch(target: object, key: string, make: (orig: AnyFn) => AnyFn): void {
  const t = target as Record<string, unknown>
  const orig = t[key]

  if (typeof orig !== 'function') {
    return
  }

  patched.push({ target: t, key, fn: orig })
  t[key] = make(orig as AnyFn)
}

/** Resolver functions, callback and promise flavours, whose first argument is the name asked for. */
const RESOLVE_FNS = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse']

function installDnsGuard(allowed: (host: string) => boolean): void {
  const refusal = (host: string) => Object.assign(new OfflineError(`la résolution de ${host}`), { hostname: host })

  const withCallback = (orig: AnyFn) =>
    function guarded(this: unknown, ...args: unknown[]) {
      const host = typeof args[0] === 'string' ? args[0] : ''

      if (host && !allowed(host)) {
        const cb = args.findLast(a => typeof a === 'function') as ((e: Error) => void) | undefined
        const error = refusal(host)

        if (cb) {
          process.nextTick(() => cb(error))
        }

        return undefined
      }

      return orig.apply(this, args)
    }

  const withPromise = (orig: AnyFn) =>
    function guarded(this: unknown, ...args: unknown[]) {
      const host = typeof args[0] === 'string' ? args[0] : ''

      return host && !allowed(host) ? Promise.reject(refusal(host)) : orig.apply(this, args)
    }

  for (const key of RESOLVE_FNS) {
    patch(dns, key, withCallback)
    patch(dns.Resolver.prototype, key, withCallback)
    patch(dns.promises, key, withPromise)
    patch(dns.promises.Resolver.prototype, key, withPromise)
  }

  // Named imports (`import { lookup } from 'node:dns'`) follow the replaced functions.
  syncBuiltinESMExports()
}

/** The destination of a `send`: the last string argument before the callback (port then address), else the `connect` peer. */
export function sendTarget(args: unknown[], connected: string | undefined): string {
  const values = typeof args.at(-1) === 'function' ? args.slice(0, -1) : args
  const address = values.slice(1).findLast(a => typeof a === 'string')

  return typeof address === 'string' && address ? address : (connected ?? 'localhost')
}

const udpPeers = new WeakMap<dgram.Socket, string>()

function installDgramGuard(allowed: (host: string) => boolean): void {
  const refuse = (socket: dgram.Socket, host: string, cb: unknown) => {
    const error = new OfflineError(`l'envoi UDP vers ${host}`)

    if (typeof cb === 'function') {
      process.nextTick(() => (cb as (e: Error) => void)(error))
    } else {
      process.nextTick(() => socket.emit('error', error))
    }
  }

  patch(dgram.Socket.prototype, 'connect', orig =>
    function guarded(this: dgram.Socket, ...args: unknown[]) {
      const host = typeof args[1] === 'string' && args[1] ? args[1] : 'localhost'

      if (!allowed(host)) {
        refuse(this, host, undefined)

        return undefined
      }

      udpPeers.set(this, host)

      return orig.apply(this, args)
    }
  )

  patch(dgram.Socket.prototype, 'send', orig =>
    function guarded(this: dgram.Socket, ...args: unknown[]) {
      // Judged on EVERY send: switching the policy off also stops a socket that is already connected.
      const host = sendTarget(args, udpPeers.get(this))

      if (!allowed(host)) {
        refuse(this, host, args.at(-1))

        return undefined
      }

      return orig.apply(this, args)
    }
  )
}

/** Tests only: puts the original back. */
export function uninstallSocketGuard(): void {
  if (installed) {
    net.Socket.prototype.connect = installed as unknown as typeof net.Socket.prototype.connect
    installed = null
    open.clear()
  }

  for (const { target, key, fn } of patched.splice(0).reverse()) {
    target[key] = fn
  }

  syncBuiltinESMExports()
}
