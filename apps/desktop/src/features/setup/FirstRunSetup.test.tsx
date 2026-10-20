// @vitest-environment jsdom
/**
 * HANDOFF 4.A.2, the other half: once `setup.open` has run, the wizard is on screen. Together with
 * `src/shell/CommandBar.test.tsx` this holds the whole path, command bar → command → wizard, and it
 * is closable again without marking first run as finished.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupCommands } from '../../commands/setup.ts'
import { defineCommands, resetCommands, runCommand } from '../../store/os-commands.ts'
import { $setupRequested } from '../../store/setup.ts'
import { FirstRunSetup } from './FirstRunSetup.tsx'

const finish = vi.fn(async () => undefined)

beforeEach(() => {
  finish.mockClear()
  resetCommands()
  defineCommands(setupCommands)
  $setupRequested.set(false)
  ;(window as unknown as { jarodOS: unknown }).jarodOS = { setup: { state: async () => ({ mode: 'desktop', needed: false }), finish } }
})

afterEach(() => {
  cleanup()
})

describe('the setup wizard on demand', () => {
  it('shows nothing when first run is done and nobody asked', async () => {
    render(<FirstRunSetup />)
    await act(async () => undefined)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens when the setup.open command runs, and closes without finishing first run', async () => {
    render(<FirstRunSetup />)
    await act(async () => undefined)

    const result = await act(async () => runCommand('setup.open', {}, { source: 'palette' }))

    expect(result).toMatchObject({ ok: true })
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect($setupRequested.get()).toBe(true)

    fireEvent.click(screen.getAllByRole('button').find(button => button.querySelector('svg') && !button.textContent?.trim()) as HTMLElement)

    await act(async () => undefined)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect($setupRequested.get()).toBe(false)
    expect(finish).not.toHaveBeenCalled()
  })
})
