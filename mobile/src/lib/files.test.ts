import { describe, expect, it } from 'vitest'
import { fromBase64, toBase64 } from './files.ts'

describe('base64', () => {
  it('round-trips any bytes, even a large block', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256)
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })
  it('reads an empty string as no bytes', () => {
    expect(fromBase64('')).toEqual(new Uint8Array())
  })
})
