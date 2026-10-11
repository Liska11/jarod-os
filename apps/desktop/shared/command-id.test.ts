import { describe, expect, it } from 'vitest'
import { isCommandId } from './command-id.ts'

describe('isCommandId', () => {
  it('accepts area.verb, camelCase and underscores after the first segment', () => {
    for (const id of ['page.open', 'memory.add', 'software.local_model', 'system.setVolume', 'a1.b2.c3']) {
      expect(isCommandId(id), id).toBe(true)
    }
  })

  it('rejects anything else', () => {
    for (const id of ['', 'page', 'Page.open', 'page.Open', 'page._open', 'page.open now', 'page..open', 'page.open;', '1page.open', 'page_x.open']) {
      expect(isCommandId(id), id).toBe(false)
    }
  })
})
