import { describe, expect, it } from 'vitest'
import { lastBackendError } from './manager.ts'

/**
 * La raison montrée à l'écran quand le noyau refuse de démarrer (code 3) : c'est cette fonction qui
 * l'extrait de `logTail`, donc c'est ici que se prouve « logTail ne reflète pas un secret brut ».
 */
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345'

describe('lastBackendError', () => {
  it('rend la dernière raison du noyau, préfixe retiré', () => {
    const tail = [
      '[out] HERMES_BACKEND_READY port=51234',
      '[err] Ce profil est déjà servi par un autre processus (pid 42).',
      '[out] ligne suivante'
    ]

    expect(lastBackendError(tail)).toBe('Ce profil est déjà servi par un autre processus (pid 42).')
  })

  it('masque une clé d’API avant de la montrer', () => {
    const reason = lastBackendError([`[err] le fournisseur a refusé la clé ${SECRET}`])

    expect(reason).toContain('sk-[masqué]')
    expect(reason).not.toContain('sk-abc')
  })

  it('masque un jeton passé dans une URL', () => {
    const reason = lastBackendError(['[err] GET http://127.0.0.1:9/api/status?token=sup3rs3cr3t -> 401'])

    expect(reason).not.toContain('sup3rs3cr3t')
    expect(reason).toContain('token=[masqué]')
  })

  it('ne prend ni une ligne qui n’est pas une erreur, ni une raison vide', () => {
    expect(lastBackendError(['[out] prêt', '[out] encore'])).toBeUndefined()
    expect(lastBackendError(['[err] ', '[err]    '])).toBeUndefined()
    expect(lastBackendError([])).toBeUndefined()
  })

  it('borne une raison interminable', () => {
    const reason = lastBackendError([`[err] ${'x'.repeat(5_000)}`])

    expect(reason).toBeDefined()
    expect((reason as string).length).toBeLessThanOrEqual(401)
    expect(reason).toMatch(/…$/)
  })
})
