import { BROWSER_KEYS, type BrowserPort, type BrowserSnapshot } from './types.ts'

/*
 * The agent's browser, as the Jarod engine drives it: one isolated window (agent-browser.ts) that the `browser_*` tools open, read, click in and type into.
 * The engine runs in its own process and has no window, so each tool call arrives here as one `op` with its arguments (see gestures: kind `browser`).
 * Nothing is trusted: the operation is on a closed list, every argument is checked, and a failure comes back as a sentence, never as a thrown error.
 */

export type BrowserHostPort = BrowserPort & { forget(): Promise<void> }

export type BrowserAnswer = { ok: true; snapshot?: BrowserSnapshot } | { ok: false; error: string }

const DIRECTIONS = ['down', 'up', 'top', 'bottom'] as const
const MAX_TEXT = 10_000
const MAX_URL = 4000

export const BROWSER_OPS = ['open', 'read', 'click', 'type', 'press', 'scroll', 'back', 'wait', 'reveal', 'close', 'forget'] as const

const fail = (error: string): BrowserAnswer => ({ ok: false, error })

function index(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1000 ? value : null
}

export async function runBrowserOp(browser: BrowserHostPort, op: unknown, args: unknown): Promise<BrowserAnswer> {
  const a = (Array.isArray(args) ? args : []) as unknown[]

  try {
    switch (op) {
      case 'open': {
        if (typeof a[0] !== 'string' || a[0].length > MAX_URL) {
          return fail('adresse attendue (texte)')
        }

        return { ok: true, snapshot: await browser.open(a[0]) }
      }
      case 'read':
        return { ok: true, snapshot: await browser.read() }
      case 'click': {
        const i = index(a[0])

        return i === null ? fail('numéro d’élément attendu') : { ok: true, snapshot: await browser.click(i) }
      }
      case 'type': {
        const i = index(a[0])

        if (i === null || typeof a[1] !== 'string' || a[1].length > MAX_TEXT || typeof a[2] !== 'boolean') {
          return fail('saisie : numéro, texte (10 000 caractères au plus) et envoi (oui/non) attendus')
        }

        return { ok: true, snapshot: await browser.type(i, a[1], a[2]) }
      }
      case 'press': {
        if (typeof a[0] !== 'string' || !(BROWSER_KEYS as readonly string[]).includes(a[0])) {
          return fail(`touche non permise (permises : ${BROWSER_KEYS.join(', ')})`)
        }

        return { ok: true, snapshot: await browser.press(a[0]) }
      }
      case 'scroll': {
        if (typeof a[0] !== 'string' || !(DIRECTIONS as readonly string[]).includes(a[0])) {
          return fail(`direction attendue : ${DIRECTIONS.join(', ')}`)
        }

        return { ok: true, snapshot: await browser.scroll(a[0] as (typeof DIRECTIONS)[number]) }
      }
      case 'back':
        return { ok: true, snapshot: await browser.back() }
      case 'wait': {
        if (typeof a[0] !== 'number' || !Number.isFinite(a[0]) || a[0] < 0 || a[0] > 60 || (a[1] !== undefined && a[1] !== null && (typeof a[1] !== 'string' || a[1].length > 500))) {
          return fail('attente : de 0 à 60 secondes, et un texte à attendre (500 caractères au plus)')
        }

        return { ok: true, snapshot: await browser.wait(a[0], typeof a[1] === 'string' ? a[1] : undefined) }
      }
      case 'reveal':
        await browser.reveal()

        return { ok: true }
      case 'close':
        await browser.close()

        return { ok: true }
      case 'forget':
        await browser.forget()

        return { ok: true }
      default:
        return fail(`opération inconnue : ${String(op).slice(0, 40)}`)
    }
  } catch (error) {
    return fail((error instanceof Error ? error.message : String(error)).slice(0, 500))
  }
}
