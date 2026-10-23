import { describe, expect, it } from 'vitest'
import { GATEWAY_PROTOCOL, gatewayProtocols, gatewaySocketTarget } from './ws-auth.ts'

describe('gatewaySocketTarget', () => {
  it('garde le jeton hors de l’URL pour le noyau Jarod (défaut)', () => {
    expect(gatewaySocketTarget('ws://127.0.0.1:9/api/ws', 'abc_DEF-123')).toEqual({ url: 'ws://127.0.0.1:9/api/ws', protocols: [GATEWAY_PROTOCOL, 'jarod.token.abc_DEF-123'] })
  })

  it('met le jeton en `?token=` pour un backend Hermes, sans sous-protocole', () => {
    expect(gatewaySocketTarget('ws://127.0.0.1:9/api/ws', 'abc_DEF-123', 'query')).toEqual({ url: 'ws://127.0.0.1:9/api/ws?token=abc_DEF-123' })
  })

  it('encode un jeton Hermes et conserve les paramètres existants', () => {
    expect(gatewaySocketTarget('ws://127.0.0.1:9/api/ws?x=1', 'a+b/c=', 'query').url).toBe('ws://127.0.0.1:9/api/ws?x=1&token=a%2Bb%2Fc%3D')
  })

  it('n’ajoute rien sans jeton', () => {
    expect(gatewaySocketTarget('ws://127.0.0.1:9/api/ws', null, 'query')).toEqual({ url: 'ws://127.0.0.1:9/api/ws' })
  })
})

describe('gatewayProtocols', () => {
  it('offre le nom du protocole puis le jeton en sous-protocole', () => {
    expect(gatewayProtocols('V3Qy-token_base64url-abcdef')).toEqual([GATEWAY_PROTOCOL, 'jarod.token.V3Qy-token_base64url-abcdef'])
  })

  it('n’offre que le nom sans jeton (le serveur exige alors un jeton par ailleurs)', () => {
    expect(gatewayProtocols(null)).toEqual([GATEWAY_PROTOCOL])
    expect(gatewayProtocols(undefined)).toEqual([GATEWAY_PROTOCOL])
    expect(gatewayProtocols('')).toEqual([GATEWAY_PROTOCOL])
  })

  it('refuse un jeton qui ne peut pas être un jeton RFC 7230, plutôt que de le remettre dans l’URL', () => {
    for (const bad of ['jeton avec espace', 'jeton/avec/slash', 'jeton=avec=egal', 'jeton\nligne']) {
      expect(() => gatewayProtocols(bad), bad).toThrow(/RFC 7230/)
    }
  })
})
