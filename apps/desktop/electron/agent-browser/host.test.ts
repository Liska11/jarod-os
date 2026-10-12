import { describe, expect, it, vi } from 'vitest'
import { type BrowserHostPort, runBrowserOp } from './host.ts'

const snap = { url: 'https://example.org/', title: 'Example', text: 'hello', elements: [] }

function fake() {
  const calls: [string, ...unknown[]][] = []
  const rec = (name: string) => vi.fn(async (...args: unknown[]) => (calls.push([name, ...args]), snap))
  const port = {
    open: rec('open'),
    read: rec('read'),
    click: rec('click'),
    type: rec('type'),
    press: rec('press'),
    scroll: rec('scroll'),
    back: rec('back'),
    wait: rec('wait'),
    reveal: vi.fn(async () => void calls.push(['reveal'])),
    close: vi.fn(async () => void calls.push(['close'])),
    forget: vi.fn(async () => void calls.push(['forget']))
  } satisfies BrowserHostPort

  return { port: port as unknown as BrowserHostPort, calls }
}

describe('runBrowserOp', () => {
  it('runs each operation with its arguments and returns the snapshot', async () => {
    const { port, calls } = fake()

    expect(await runBrowserOp(port, 'open', ['https://example.org'])).toEqual({ ok: true, snapshot: snap })
    await runBrowserOp(port, 'read', [])
    await runBrowserOp(port, 'click', [3])
    await runBrowserOp(port, 'type', [1, 'hello', true])
    await runBrowserOp(port, 'press', ['Enter'])
    await runBrowserOp(port, 'scroll', ['down'])
    await runBrowserOp(port, 'back', [])
    await runBrowserOp(port, 'wait', [2, 'Done'])
    await runBrowserOp(port, 'wait', [1])
    expect(await runBrowserOp(port, 'reveal', [])).toEqual({ ok: true })
    expect(await runBrowserOp(port, 'close', [])).toEqual({ ok: true })
    expect(await runBrowserOp(port, 'forget', [])).toEqual({ ok: true })
    expect(calls).toEqual([['open', 'https://example.org'], ['read'], ['click', 3], ['type', 1, 'hello', true], ['press', 'Enter'], ['scroll', 'down'], ['back'], ['wait', 2, 'Done'], ['wait', 1, undefined], ['reveal'], ['close'], ['forget']])
  })

  it('refuses what is not on the closed lists, without calling the browser', async () => {
    const { port, calls } = fake()
    const refused = async (op: unknown, args: unknown) => {
      const answer = await runBrowserOp(port, op, args)

      expect(answer.ok, `${String(op)} ${JSON.stringify(args)}`).toBe(false)
    }

    await refused('rm', [])
    await refused(undefined, [])
    await refused('constructor', [])
    await refused('open', [])
    await refused('open', [42])
    await refused('open', ['x'.repeat(4001)])
    await refused('click', ['1'])
    await refused('click', [-1])
    await refused('click', [1.5])
    await refused('click', [1000])
    await refused('type', [1, 'x'])
    await refused('type', [1, 'x'.repeat(10_001), false])
    await refused('type', ['1', 'x', false])
    await refused('press', ['Control+Alt+Delete'])
    await refused('press', ['F5'])
    await refused('scroll', ['sideways'])
    await refused('wait', [61])
    await refused('wait', [-1])
    await refused('wait', ['2'])
    await refused('wait', [1, 'x'.repeat(501)])
    expect(calls).toEqual([])
  })

  it('a refusal by the browser (a private address, a timeout) comes back as a sentence, never a throw', async () => {
    const { port } = fake()

    ;(port.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('adresse refusée : local ou interne'))
    expect(await runBrowserOp(port, 'open', ['http://127.0.0.1'])).toEqual({ ok: false, error: 'adresse refusée : local ou interne' })
    ;(port.read as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('x'.repeat(900)))

    const long = await runBrowserOp(port, 'read', [])

    expect(long.ok).toBe(false)
    expect((long as { error: string }).error).toHaveLength(500)
  })

  it('bad arguments of the wrong shape are tolerated', async () => {
    const { port } = fake()

    expect((await runBrowserOp(port, 'click', null)).ok).toBe(false)
    expect((await runBrowserOp(port, 'read', 'junk')).ok).toBe(true)
  })
})
