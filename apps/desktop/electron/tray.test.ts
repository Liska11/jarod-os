import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, Menu: {}, nativeImage: {}, Tray: class {} }))

const { trayLabels, trayLanguage } = await import('./tray.ts')

describe('tray menu', () => {
  it('speaks the chosen language, else French on a French system, else English', () => {
    expect(trayLanguage('en', 'fr-FR')).toBe('en')
    expect(trayLanguage('fr', 'en-US')).toBe('fr')
    expect(trayLanguage('auto', 'fr-CA')).toBe('fr')
    expect(trayLanguage(undefined, 'de')).toBe('en')
  })

  it('offers safe mode, or the way back from it', () => {
    expect(trayLabels('fr', false).restart).toBe('Redémarrer en mode sans échec')
    expect(trayLabels('en', true).restart).toBe('Restart normally')
  })
})
