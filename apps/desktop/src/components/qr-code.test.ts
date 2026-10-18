import { describe, expect, it } from 'vitest'
import { qrMatrix, qrPath } from './qr-code.tsx'

const URL = 'http://192.168.1.42:8765/#AbCdEf123456'

describe('qrMatrix', () => {
  it('encodes the pairing address as a square QR code with its three finder patterns', () => {
    const m = qrMatrix(URL)
    const n = m.length

    expect(n).toBeGreaterThanOrEqual(21)
    expect((n - 17) % 4).toBe(0) // QR sizes are 21, 25, 29… (version 1 + 4 per version)
    expect(m.every(row => row.length === n)).toBe(true)
    // a finder pattern: a dark 7x7 ring in the top-left, top-right and bottom-left corners
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      expect(m[r][c] && m[r][c + 6] && m[r + 6][c] && m[r + 6][c + 6]).toBe(true)
      expect(m[r + 1][c + 1]).toBe(false)
      expect(m[r + 3][c + 3]).toBe(true)
    }
  })

  it('changes with the code, and is the same for the same address', () => {
    expect(qrMatrix(URL)).toEqual(qrMatrix(URL))
    expect(qrMatrix(URL)).not.toEqual(qrMatrix(`${URL}X`))
  })
})

describe('qrPath', () => {
  it('draws one unit square per dark module, offset by the quiet zone', () => {
    expect(qrPath([[true, false], [false, true]], 4)).toBe('M4 4h1v1h-1zM5 5h1v1h-1z')
  })
})
