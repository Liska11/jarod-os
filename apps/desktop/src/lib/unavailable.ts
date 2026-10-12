/*
 * Something the engine knows it does not do in this version: the Jarod gateway answers every such call with this one sentence (RPC error, or the `detail` of a
 * REST 404). It is a state, not a failure: pages show it as "Not available in this version", never as a red error or a "Some sources did not load".
 */

export const NOT_AVAILABLE = 'Not available in this version'

const SENTENCE = /not available in this version/i

export function isNotAvailable(error: unknown): boolean {
  return SENTENCE.test(error instanceof Error ? error.message : String(error ?? ''))
}

/** The text to show for a failed call: the one sentence for a known gap, the error's own message otherwise. */
export function failureText(error: unknown): string {
  return isNotAvailable(error) ? NOT_AVAILABLE : error instanceof Error ? error.message : String(error)
}
