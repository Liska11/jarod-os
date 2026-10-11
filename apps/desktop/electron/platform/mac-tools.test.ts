import { describe, expect, it } from 'vitest'
import { parseVisionOutput } from './mac-tools.ts'

describe('parseVisionOutput', () => {
  it('keeps the lines Vision read, trimmed, without blanks', () => {
    expect(parseVisionOutput('["Hello from Jarod-OS", "  Order 4471 ", ""]\n')).toEqual(['Hello from Jarod-OS', 'Order 4471'])
  })

  it('treats anything else as nothing found', () => {
    expect(parseVisionOutput('')).toEqual([])
    expect(parseVisionOutput('not json')).toEqual([])
    expect(parseVisionOutput('{"a": 1}')).toEqual([])
    expect(parseVisionOutput('[1, "x"]')).toEqual(['x'])
  })
})
