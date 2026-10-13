/*
 * The first-run Telegram step's checks, run in main so the token never meets the page's network rules and is never
 * logged: the token's shape, then `getMe` (the bot exists), then a round trip — wait for the person to write to the bot
 * (`getUpdates`), answer them (`sendMessage`). It runs before the token is saved and the gateway started: while the
 * gateway polls, `getUpdates` would compete with it. The token itself is saved by the core (its encrypted store),
 * through `update-messaging-platform`.
 */

import type { TelegramBot, TelegramRoundTrip } from '../../shared/ipc.ts'

export const TELEGRAM_API = 'https://api.telegram.org'
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

type Fetch = typeof fetch

export function tokenProblem(token: string): string | null {
  return TOKEN_SHAPE.test(token.trim()) ? null : 'This does not look like a bot token (digits, a colon, then about 35 letters, digits, - or _).'
}

async function call<T>(fetchImpl: Fetch, token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<{ ok: boolean; result?: T; description?: string }> {
  const response = await fetchImpl(`${TELEGRAM_API}/bot${token.trim()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  return (await response.json()) as { ok: boolean; result?: T; description?: string }
}

/** The bot behind `token`, or why it is refused. */
export async function checkBot(token: string, fetchImpl: Fetch = fetch): Promise<TelegramBot> {
  const problem = tokenProblem(token)
  if (problem) return { ok: false, error: problem, code: 'shape' }
  try {
    const reply = await call<{ username?: string; first_name?: string }>(fetchImpl, token, 'getMe')
    if (!reply.ok) {
      const unauthorized = reply.description === 'Unauthorized'
      return { ok: false, error: unauthorized ? 'Telegram refused this token: copy it again from @BotFather.' : (reply.description ?? 'Telegram refused this token.'), code: unauthorized ? 'unauthorized' : 'refused' }
    }
    return { ok: true, username: reply.result?.username, name: reply.result?.first_name }
  } catch (error) {
    return { ok: false, error: `Telegram could not be reached: ${(error as Error).message}`, code: 'network' }
  }
}

interface Update {
  update_id: number
  message?: { chat: { id: number }; from?: { first_name?: string; username?: string }; date: number }
}

/**
 * Wait up to `waitSeconds` for a message written to the bot after `since` (unix seconds), then answer it with `reply`.
 * Older messages waiting in the bot's queue are skipped, not answered.
 */
export async function roundTrip(token: string, reply: string, options: { waitSeconds?: number; since?: number; fetchImpl?: Fetch; signal?: AbortSignal } = {}): Promise<TelegramRoundTrip> {
  const fetchImpl = options.fetchImpl ?? fetch
  const since = options.since ?? Math.floor(Date.now() / 1000) - 5
  const deadline = Date.now() + (options.waitSeconds ?? 120) * 1000
  let offset: number | undefined

  try {
    while (Date.now() < deadline && !options.signal?.aborted) {
      const wait = Math.max(1, Math.min(25, Math.floor((deadline - Date.now()) / 1000)))
      const updates = await call<Update[]>(fetchImpl, token, 'getUpdates', { offset, timeout: wait, allowed_updates: ['message'] }, (wait + 10) * 1000)
      if (!updates.ok) return { ok: false, error: updates.description ?? 'Telegram refused getUpdates.', code: 'refused' }
      for (const update of updates.result ?? []) {
        offset = update.update_id + 1
        const message = update.message
        if (!message || message.date < since) continue
        const sent = await call(fetchImpl, token, 'sendMessage', { chat_id: message.chat.id, text: reply })
        // Acknowledge what was read so the gateway does not answer it again.
        await call(fetchImpl, token, 'getUpdates', { offset, timeout: 0 }).catch(() => undefined)
        if (!sent.ok) return { ok: false, error: sent.description ?? 'Telegram refused to send the answer.', code: 'refused' }
        return { ok: true, from: message.from?.username ? `@${message.from.username}` : (message.from?.first_name ?? 'someone') }
      }
    }
    return { ok: false, error: 'No message reached the bot in time. Open the bot in Telegram, send it any message, then try again.', code: 'no-message' }
  } catch (error) {
    return { ok: false, error: `Telegram could not be reached: ${(error as Error).message}`, code: 'network' }
  }
}
