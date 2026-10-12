import { describe, expect, it } from 'vitest'
import { GATEWAY_PROTOCOL, gatewayProtocols } from './ws-auth.ts'

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
