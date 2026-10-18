import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** What the e2e needs around the built app: a scripted model, a controlled site, and a way to look at the machine's processes and temp folders. */

type Chunk = Record<string, unknown>

const delta = (d: Chunk): Chunk => ({ choices: [{ delta: d }] })
const stop = (reason = 'stop'): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 3 } })

export const say = (text: string): Chunk[] => [delta({ content: text }), stop()]

export const browserCall = (args: Record<string, unknown>): Chunk[] => [
  delta({ tool_calls: [{ index: 0, id: `call-${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: 'connected_browser', arguments: JSON.stringify(args) } }] }),
  stop('tool_calls')
]

export interface FakeModel {
  port: number
  /** The next replies, one per request the app makes. */
  queue: Chunk[][]
  /** The tool names offered to the model in each request. */
  offered: string[][]
  close: () => Promise<void>
}

export async function startFakeModel(): Promise<FakeModel> {
  const queue: Chunk[][] = []
  const offered: string[][] = []
  const server: Server = createServer((req, res) => {
    let raw = ''

    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      try {
        const body = JSON.parse(raw) as { tools?: { function: { name: string } }[] }

        offered.push((body.tools ?? []).map(t => t.function.name))
      } catch {
        offered.push([])
      }

      const chunks = queue.shift() ?? say('(nothing planned)')

      res.writeHead(200, { 'content-type': 'text/event-stream' })

      for (const c of chunks) {
        res.write(`data: ${JSON.stringify(c)}\n\n`)
      }

      res.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  return { port: (server.address() as AddressInfo).port, queue, offered, close: () => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve()))) }
}

export interface Site {
  port: number
  hits: { host: string; path: string }[]
  url: (path?: string) => string
  close: () => Promise<void>
}

/** A controlled site on a dotted loopback name (`site.localhost`, which the user setting accepts; a bare `localhost` it does not). */
export async function startSite(): Promise<Site> {
  const hits: Site['hits'] = []
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')

    hits.push({ host: (req.headers.host ?? '').replace(/:\d+$/, ''), path: u.pathname })

    const page = (body: string) => `<!doctype html><meta charset="utf-8"><title>${u.pathname}</title>${body}`

    if (u.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page('<p>SLOW</p>'))
      }, Number(u.searchParams.get('ms') ?? 20_000))

      return
    }

    res.writeHead(u.pathname === '/favicon.ico' ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })

    if (u.pathname === '/ticker') {
      res.end(page("<p>TICKER</p><script>setInterval(function(){fetch('/tick').catch(function(){})},80);setInterval(function(){new Image().src='/tickimg?'+Math.random()},120)</script>"))
    } else {
      res.end(page(`<h1>E2E ${u.pathname}</h1>`))
    }
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  const port = (server.address() as AddressInfo).port

  return { port, hits, url: (path = '/') => `http://site.localhost:${port}${path}`, close: () => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve()))) }
}

const ps = (script: string): string => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()

/** Number of processes whose command line contains `needle` (the interrogation itself excluded). */
export function processesUsing(needle: string): number {
  const out = ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle.replace(/'/g, "''")}') -and $_.CommandLine -notmatch 'Get-CimInstance' } | Measure-Object | ForEach-Object { $_.Count }`)

  return Number(out || '0')
}

export function killTree(pid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* already gone */
  }
}

const ancestry = new Map<number, boolean>()

/** True when `pid` is `ancestor` or one of its descendants (the gateway is a child of the Electron main process). */
export function isDescendantOf(pid: number, ancestor: number): boolean {
  const key = pid * 1_000_000 + ancestor

  if (ancestry.has(key)) {
    return ancestry.get(key)!
  }

  let current = pid
  let found = false

  for (let depth = 0; depth < 6 && current > 0 && !found; depth++) {
    if (current === ancestor) {
      found = true
      break
    }

    current = Number(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${current}').ParentProcessId`) || '0')
  }

  ancestry.set(key, found)

  return found
}

/**
 * One call to the core over the test's own line to the gateway (`jarod.invoke`), opened for that call and closed at once: the gateway asks the most
 * recent connection for native gestures, which must stay the window's. Used to read state back, never to approve anything.
 */
export async function invokeCore<T = unknown>(state: { wsUrl?: string; wsToken?: string }, channel: string, ...args: unknown[]): Promise<T> {
  const ws = new WebSocket(`${state.wsUrl}?token=${state.wsToken}`)

  try {
    await new Promise<void>((ok, bad) => {
      ws.addEventListener('open', () => ok())
      ws.addEventListener('error', () => bad(new Error('control line refused')))
    })

    return await new Promise<T>((ok, bad) => {
      ws.addEventListener('message', event => {
        const frame = JSON.parse(String(event.data)) as { id?: number; result?: { result: T }; error?: { message?: string } }

        if (frame.id === 1) {
          frame.error ? bad(new Error(frame.error.message ?? 'error')) : ok(frame.result!.result)
        }
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'jarod.invoke', params: { channel, args } }))
    })
  } finally {
    ws.close()
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}
