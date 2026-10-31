/** What went wrong, in terms of what the person can do about it; `null` for an error we have no plain words for (the raw text is shown as it is). */
export type ErrorKind = 'tooManyTools' | 'auth' | 'credit' | 'quota' | 'unreachable' | 'timeout' | 'server' | 'badRequest'

export interface ErrorExplanation {
  kind: ErrorKind
  /** A number the explanation quotes (the tool limit, the HTTP status). */
  value?: number
}

/** A provider or network error as the backend relays it ("HTTP 400: {...}", "fetch failed"…) turned into a known cause. */
export function explainError(raw: string): ErrorExplanation | null {
  const text = raw.trim()

  if (!text) {
    return null
  }

  const tools = /maximum number of items is (\d+)/i.exec(text) ?? /(?:too many|maximum of) (\d+) tools/i.exec(text)

  if (tools && /tools?\b/i.test(text)) {
    return { kind: 'tooManyTools', value: Number(tools[1]) }
  }

  const status = /\bHTTP (\d{3})\b/i.exec(text)
  const code = status ? Number(status[1]) : 0

  if (code === 401 || code === 403 || /invalid api key|incorrect api key|unauthori[sz]ed/i.test(text)) {
    return { kind: 'auth' }
  }

  if (code === 402 || /insufficient (balance|credit|funds|quota)|billing|credit balance/i.test(text)) {
    return { kind: 'credit' }
  }

  if (code === 429 || /rate.?limit|quota exceeded|too many requests/i.test(text)) {
    return { kind: 'quota' }
  }

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up|connection refused/i.test(text)) {
    return { kind: 'unreachable' }
  }

  if (/timed? ?out|timeout|aborted due to timeout|ETIMEDOUT/i.test(text)) {
    return { kind: 'timeout' }
  }

  if (code >= 500 && code < 600) {
    return { kind: 'server', value: code }
  }

  if (code === 400 || code === 404 || code === 422) {
    return { kind: 'badRequest', value: code }
  }

  return null
}
