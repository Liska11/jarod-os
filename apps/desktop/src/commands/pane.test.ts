import { describe, expect, it } from 'vitest'
import { paneAppId } from './pane-names.ts'

describe('paneAppId', () => {
  it('accepts the integrated apps by id, in any case', () => {
    for (const id of ['browser', 'tiktok', 'instagram', 'telegram', 'whatsapp', 'signal', 'player', 'moviebox']) {
      expect(paneAppId(id)).toBe(id)
      expect(paneAppId(` ${id.toUpperCase()} `)).toBe(id)
    }
  })

  it('maps the words people use for the browser and the player', () => {
    for (const word of ['Navigateur', 'Brave', 'web', 'internet', 'browser']) expect(paneAppId(word)).toBe('browser')
    expect(paneAppId('Lecteur')).toBe('player')
  })

  it('refuses what is not an integrated app', () => {
    for (const bad of ['', 'chrome', 'pinokio', 'rm -rf']) expect(paneAppId(bad)).toBeNull()
  })
})
