// @vitest-environment jsdom
/**
 * « Capacités & Évolution » vue de la fenêtre : quatre sections lisent les RPC et un bouton déclenche
 * exactement une méthode. Le gateway est une doublure : ce qu'on vérifie, c'est ce que l'écran fait.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const call = vi.fn()

vi.mock('../../store/gateway.ts', () => ({
  gatewayCall: (...args: unknown[]) => call(...args),
  gatewayRequest: vi.fn(),
  onAnyGatewayEvent: () => () => undefined,
}))

const { CapabilitiesPage } = await import('./CapabilitiesPage.tsx')

const TRUST = {
  plugins: [
    { name: 'des', version: '1.0.0', status: 'enabled', trust: 'local', trustKey: 'local-1', trustRevoked: false, state: 'active', tools: ['des_roll'] },
    { name: 'fx-official', version: '1.0.0', status: 'installed', trust: 'official', trustKey: 'k-official', trustRevoked: false, state: 'disabled', tools: [] },
    { name: 'fx-verified', version: '1.0.0', status: 'installed', trust: 'verified', trustKey: 'k-verified', trustRevoked: false, state: 'disabled', tools: [] },
    { name: 'fx-community', version: '1.0.0', status: 'installed', trust: 'community', trustKey: 'k-comm', trustRevoked: true, state: 'disabled', tools: [] },
  ],
}

let capabilityStatus = 'analyzed'
const caps = () => ({
  registry: {
    capabilities: {
      'cap-demo': { id: 'cap-demo', name: 'Capacité de démonstration', type: 'skill', version: '1.0.0', status: capabilityStatus, verdict: 'safe', hash: 'a'.repeat(64), source: 'D:\\tmp\\comp' },
    },
  },
})

const DEPS = {
  components: [
    { id: 'node', name: 'Node.js', installed: true, version: '26.12.1', critical: true, candidates: [{}, {}] },
    { id: 'restic', name: 'restic', installed: false, version: null, critical: false, candidates: [] },
  ],
}
let depPolicy = 'notify'
const depsState = () => ({ state: { components: { node: { policy: depPolicy, compatibility: 'unverified', previous: null } } } })

function route(method: string): unknown {
  switch (method) {
    case 'trust.installed':
      return TRUST
    case 'capability.registry':
      return caps()
    case 'deps.inventory':
      return DEPS
    case 'deps.state':
      return depsState()
    case 'capability.integrate':
      capabilityStatus = 'active'
      return { ok: true, entry: { id: 'cap-demo', status: 'active' } }
    case 'capability.set-active':
      return { ok: true, status: 'disabled' }
    case 'deps.propose':
      return {
        id: 'node',
        name: 'Node.js',
        current: '26.12.1',
        available: null,
        risk: 'critical',
        updatePossible: false,
        recommendation: 'ne rien faire sans connaître la version disponible',
        missing: ['version disponible inconnue : la découverte exige winget (réseau) et un accord'],
      }
    case 'deps.policy':
      depPolicy = 'auto-safe'
      return { ok: true }
    default:
      return { ok: true }
  }
}

beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (method: string) => route(method))
  capabilityStatus = 'analyzed'
  depPolicy = 'notify'
})
afterEach(() => cleanup())

describe('page Capacités & Évolution', () => {
  it('affiche les quatre sections et un badge de confiance par niveau', async () => {
    render(<CapabilitiesPage />)
    await screen.findByTestId('trust-row-des')
    for (const title of ['Confiance', 'Capacités', "Dépendances d'exécution", 'Mises à jour disponibles']) {
      expect(screen.getByText(title)).toBeDefined()
    }
    expect(screen.getByTestId('trust-count').textContent).toContain('4 plugin(s)')
    const badges = Array.from(document.querySelectorAll('[data-badge]')).map(node => node.getAttribute('data-badge'))
    for (const level of ['local', 'official', 'verified', 'community']) {
      expect(badges).toContain(level)
    }
    expect(badges).toContain('cle-revoquee')
    expect(screen.getByTestId('capabilities-count').textContent).toContain('1 capacité(s)')
    expect(screen.getByTestId('deps-count').textContent).toContain('2 composant(s)')
    expect(screen.getByTestId('updates-empty')).toBeDefined()
  })

  it('un bouton de capacité déclenche le RPC et le statut change à l’écran', async () => {
    render(<CapabilitiesPage />)
    const row = await screen.findByTestId('cap-row-cap-demo')
    expect(row.querySelector('[data-status]')?.getAttribute('data-status')).toBe('analyzed')
    fireEvent.click(row.querySelector('[data-action="cap-integrate"]') as HTMLElement)
    await waitFor(() => expect(call).toHaveBeenCalledWith('capability.integrate', { id: 'cap-demo', kind: 'skill' }))
    await waitFor(() => expect(screen.getByTestId('cap-row-cap-demo').querySelector('[data-status]')?.getAttribute('data-status')).toBe('active'))
    expect((screen.getByTestId('cap-row-cap-demo').querySelector('[data-action="cap-integrate"]') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('cap-row-cap-demo').querySelector('[data-action="cap-disable"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('« Vérifier » affiche la proposition et « Politique » déclenche le RPC', async () => {
    render(<CapabilitiesPage />)
    const row = await screen.findByTestId('dep-row-node')
    fireEvent.click(row.querySelector('[data-action="dep-propose"]') as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('update-row-node').textContent).toContain('inconnue'))
    expect(screen.getByTestId('cap-last-result').textContent).toContain('risque critical')
    fireEvent.click(screen.getByTestId('dep-row-node').querySelector('[data-action="dep-policy"]') as HTMLElement)
    await waitFor(() => expect(call).toHaveBeenCalledWith('deps.policy', { id: 'node', policy: 'auto-safe' }))
    await waitFor(() => expect(screen.getByTestId('dep-row-node').querySelector('[data-policy]')?.getAttribute('data-policy')).toBe('auto-safe'))
  })

  it('un composant absent et un refus s’affichent sans casser la page', async () => {
    call.mockImplementation(async (method: string) => {
      if (method === 'deps.propose') {
        throw new Error('composant inconnu : restic')
      }
      return route(method)
    })
    render(<CapabilitiesPage />)
    const row = await screen.findByTestId('dep-row-restic')
    expect(row.textContent).toContain('absent')
    expect((row.querySelector('[data-action="dep-apply"]') as HTMLButtonElement).disabled).toBe(true)
    expect((row.querySelector('[data-action="dep-rollback"]') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(row.querySelector('[data-action="dep-propose"]') as HTMLElement)
    await waitFor(() => expect(screen.getByTestId('cap-error').textContent).toContain('composant inconnu'))
  })
})
