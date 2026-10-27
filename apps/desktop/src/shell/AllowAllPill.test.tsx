// @vitest-environment jsdom
/**
 * Le bouton « Tout autoriser » : un clic pour l'allumer, un clic pour l'éteindre.
 *
 * Ce que l'on vérifie ici, c'est le câblage : l'état vient du moteur (`get-jarod-settings` : profil + interrupteur), l'action passe par
 * l'unique canal `tools-allow-all` (avec le profil d'avant à rendre), et un refus de la confirmation native laisse le bouton éteint.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jarod = vi.fn()

vi.mock('../lib/jarod.ts', () => ({ jarod: (...args: unknown[]) => jarod(...args) }))
vi.mock('../store/notifications.ts', () => ({ notify: vi.fn() }))

import { $allowAll } from '../store/allow-all.ts'
import { AllowAllPill } from './AllowAllPill.tsx'

const settings = (accessProfile: string, autoApproveTools: boolean) => ({ accessProfile, autoApproveTools })

beforeEach(() => {
  jarod.mockReset()
  localStorage.clear()
  $allowAll.set({ on: false, busy: false })
})

afterEach(() => {
  cleanup()
})

describe('bouton « Tout autoriser »', () => {
  it('part éteint quand le moteur est sur un autre profil, et l’allume en un clic', async () => {
    jarod.mockImplementation(async (channel: string) => {
      if (channel === 'get-jarod-settings') {
        return settings('full', true)
      }

      return settings('custom', true)
    })

    render(<AllowAllPill />)
    await waitFor(() => expect(jarod).toHaveBeenCalledWith('get-jarod-settings'))
    expect(screen.getByTestId('allow-all-pill').dataset.on).toBe('no')

    fireEvent.click(screen.getByTestId('allow-all-pill'))

    await waitFor(() => expect(jarod).toHaveBeenCalledWith('tools-allow-all', true, 'full'))
    await waitFor(() => expect(screen.getByTestId('allow-all-pill').dataset.on).toBe('yes'))
  })

  it('un refus dans la confirmation native laisse le bouton éteint', async () => {
    jarod.mockImplementation(async (channel: string) => {
      if (channel === 'get-jarod-settings') {
        return settings('full', true)
      }

      throw new Error("[oneai] accord global : refusé par l'utilisateur")
    })

    render(<AllowAllPill />)
    await waitFor(() => expect(jarod).toHaveBeenCalledWith('get-jarod-settings'))

    fireEvent.click(screen.getByTestId('allow-all-pill'))

    await waitFor(() => expect($allowAll.get().busy).toBe(false))
    expect($allowAll.get().on).toBe(false)
    expect(screen.getByTestId('allow-all-pill').dataset.on).toBe('no')
  })

  it('allumé, il rend le profil d’avant et s’éteint', async () => {
    localStorage.setItem('jarod-os.allow-all.profile', 'approve')
    jarod.mockImplementation(async (channel: string) => {
      if (channel === 'get-jarod-settings') {
        return settings('custom', true)
      }

      return settings('approve', false)
    })

    render(<AllowAllPill />)
    await waitFor(() => expect(screen.getByTestId('allow-all-pill').dataset.on).toBe('yes'))

    fireEvent.click(screen.getByTestId('allow-all-pill'))

    await waitFor(() => expect(jarod).toHaveBeenCalledWith('tools-allow-all', false, 'approve'))
    await waitFor(() => expect(screen.getByTestId('allow-all-pill').dataset.on).toBe('no'))
  })
})
