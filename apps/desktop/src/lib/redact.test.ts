// Le masque du shell est la copie de celui du noyau (`jarod-core/packages/kernel/src/redact.ts`) : mêmes formes,
// mêmes vecteurs. Il sert au journal (`electron/log.ts`), aux erreurs du gestionnaire de moteur et à l'écran.
import { describe, expect, it } from 'vitest'
import { MAX_ERROR_TEXT, redactLine, redactText } from '../../shared/redact.ts'

describe('redactText', () => {
  it('masque les mêmes formes que le noyau', () => {
    expect(redactText('clé sk-abcdefghijklmnopqrstuvwxyz012345')).toContain('sk-[masqué]')
    expect(redactText('Bearer abcdefghijklmnop')).toContain('Bearer [masqué]')
    expect(redactText('"api_key": "abcdefghijklmnop"')).toContain('[masqué]')
    expect(redactText('https://x/y?token=abcdefghijklmnop')).toBe('https://x/y?token=[masqué]')
    expect(redactText(`1234567890:${'A'.repeat(40)}`)).toContain('[jeton masqué]')
    expect(redactText('ghp_ABCDEFGHIJKLMNOPQRSTUVWX')).toContain('[jeton masqué]')
    expect(redactText('xoxb-1234567890ABCDEFGH')).toContain('xox[masqué]')
  })

  it('masque à clé explicite même quand la valeur est trop courte pour le seuil de 12', () => {
    expect(redactText('https://x/y?token=abc123')).toBe('https://x/y?token=[masqué]')
    expect(redactText('password=pw1234')).toBe('password=[masqué]')
    expect(redactText('"api_key": "court"')).toContain('[masqué]')
  })

  it('est idempotent sur une valeur déjà masquée', () => {
    expect(redactText('https://x/y?token=[masqué]')).toBe('https://x/y?token=[masqué]')
  })

  it('laisse intact le texte ordinaire', () => {
    expect(redactText('le moteur a démarré sur le port 8722')).toBe('le moteur a démarré sur le port 8722')
  })
})

describe('redactLine', () => {
  it('ramène sur une ligne et borne', () => {
    expect(redactLine('a\n  b')).toBe('a b')

    const long = redactLine('x'.repeat(5_000))
    expect(long.length).toBe(MAX_ERROR_TEXT + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  it('masque avant de borner (un secret en fin de ligne ne survit pas à la coupe)', () => {
    const line = redactLine(`${'x'.repeat(500)} sk-abcdefghijklmnopqrstuvwxyz012345`)
    expect(line).not.toContain('sk-abc')
  })
})
