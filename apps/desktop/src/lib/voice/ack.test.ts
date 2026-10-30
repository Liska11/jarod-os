// Q4 (analyse du 29/10) : l'accusé de réception parlé — une phrase courte, traduite, jamais une clé brute, jamais vide.
import { describe, expect, it } from 'vitest'
import { acknowledgement } from './chained-engine.ts'

describe('accusé de réception vocal', () => {
  it('rend une phrase traduite pour chaque tirage, y compris aux bornes', () => {
    for (const r of [0, 0.3, 0.6, 0.9999, 1]) {
      const phrase = acknowledgement(() => r)
      expect(phrase.trim().length).toBeGreaterThan(0)
      expect(phrase).not.toMatch(/^voice\.ack\./)
    }
  })
})
