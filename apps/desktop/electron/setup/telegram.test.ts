import { describe, expect, it } from 'vitest'
import { checkBot, roundTrip, tokenProblem } from './telegram.ts'

const TOKEN = '1234567890:AAH9xYzAbCdEfGhIjKlMnOpQrStUvWxYz12'

/** A fake Bot API: answers each method from `replies`, records the calls. */
function fakeTelegram(replies: Record<string, unknown[]>) {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? ''
    calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) })
    const queue = replies[method] ?? []
    const reply = queue.length > 1 ? queue.shift() : queue[0]
    return new Response(JSON.stringify(reply ?? { ok: true, result: [] }))
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('tokenProblem', () => {
  it('accepts a BotFather token and refuses anything else', () => {
    expect(tokenProblem(TOKEN)).toBeNull()
    expect(tokenProblem(` ${TOKEN} `)).toBeNull()
    expect(tokenProblem('123:abc')).not.toBeNull()
    expect(tokenProblem('')).not.toBeNull()
  })
})

describe('checkBot', () => {
  it('names the bot when Telegram knows the token', async () => {
    const { fetchImpl, calls } = fakeTelegram({ getMe: [{ ok: true, result: { username: 'jarod_bot', first_name: 'Jarod' } }] })
    expect(await checkBot(TOKEN, fetchImpl)).toEqual({ ok: true, username: 'jarod_bot', name: 'Jarod' })
    expect(calls[0].method).toBe('getMe')
  })

  it('explains a refused token without calling Telegram for a malformed one', async () => {
    const { fetchImpl, calls } = fakeTelegram({ getMe: [{ ok: false, description: 'Unauthorized' }] })
    expect((await checkBot(TOKEN, fetchImpl)).error).toContain('@BotFather')
    expect((await checkBot('nope', fetchImpl)).ok).toBe(false)
    expect(calls).toHaveLength(1)
  })
})

describe('roundTrip', () => {
  it('skips old messages, answers the first new one and acknowledges it', async () => {
    const { fetchImpl, calls } = fakeTelegram({
      getUpdates: [
        {
          ok: true,
          result: [
            { update_id: 10, message: { chat: { id: 1 }, from: { first_name: 'Old' }, date: 100 } },
            { update_id: 11, message: { chat: { id: 42 }, from: { username: 'san' }, date: 2000 } }
          ]
        },
        { ok: true, result: [] }
      ],
      sendMessage: [{ ok: true, result: {} }]
    })
    const result = await roundTrip(TOKEN, 'hello', { since: 1000, waitSeconds: 5, fetchImpl })
    expect(result).toEqual({ ok: true, from: '@san' })
    const send = calls.find(c => c.method === 'sendMessage')
    expect(send?.body).toMatchObject({ chat_id: 42, text: 'hello' })
    expect(calls.at(-1)?.body).toMatchObject({ offset: 12 })
  })

  it('gives up when nobody writes in time', async () => {
    const { fetchImpl } = fakeTelegram({ getUpdates: [{ ok: true, result: [] }] })
    const result = await roundTrip(TOKEN, 'hello', { waitSeconds: 0, fetchImpl })
    expect(result.ok).toBe(false)
  })
})

describe('error codes', () => {
  it('tells a malformed token, a refused one and a silent bot apart', async () => {
    const { fetchImpl } = fakeTelegram({ getMe: [{ ok: false, description: 'Unauthorized' }], getUpdates: [{ ok: true, result: [] }] })
    expect((await checkBot('nope', fetchImpl)).code).toBe('shape')
    expect((await checkBot(TOKEN, fetchImpl)).code).toBe('unauthorized')
    expect((await roundTrip(TOKEN, 'x', { waitSeconds: 0, fetchImpl })).code).toBe('no-message')
  })
})
