import { describe, expect, it } from 'vitest'
import { LineSplitter, sameToken } from './json-lines.ts'

describe('LineSplitter', () => {
  it('returns the lines a chunk completes and keeps the rest for the next one', () => {
    const lines = new LineSplitter()

    expect(lines.push('{"cmd":"a"}\n{"cmd"')).toEqual(['{"cmd":"a"}'])
    expect(lines.push(':"b"}\n\n  \n')).toEqual(['{"cmd":"b"}'])
  })

  it('gives up on a line that never ends instead of growing without bound', () => {
    const lines = new LineSplitter(10)

    expect(lines.push('12345')).toEqual([])
    expect(lines.push('678901')).toBeNull()
  })

  it('does not count complete lines against the limit', () => {
    const lines = new LineSplitter(10)

    expect(lines.push('a'.repeat(50) + '\nb')).toEqual(['a'.repeat(50)])
  })
})

describe('sameToken', () => {
  it('accepts only the exact token', () => {
    expect(sameToken('s3cret', 's3cret')).toBe(true)
    expect(sameToken('s3cre', 's3cret')).toBe(false)
    expect(sameToken('s3cret ', 's3cret')).toBe(false)
  })

  it('refuses a missing token and never matches an empty expected one', () => {
    expect(sameToken(undefined, 's3cret')).toBe(false)
    expect(sameToken(42, 's3cret')).toBe(false)
    expect(sameToken('', '')).toBe(false)
  })
})
