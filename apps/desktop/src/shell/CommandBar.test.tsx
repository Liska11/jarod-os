// @vitest-environment jsdom
/**
 * HANDOFF 4.A.2: choosing "Open the setup wizard" in the command bar did nothing. The first component
 * test of the project holds the real `CommandPalette` (cmdk included) to the whole path: type, pick the
 * command with the keyboard and with the mouse, and the command runs and the palette closes.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../features/chat/use-slash-catalog.ts', () => ({ useSlashCatalog: () => [] }))
vi.mock('../store/native-apps.ts', () => ({ useNativeApps: () => ({ apps: [], iconFor: () => undefined }) }))
vi.mock('../store/chat.ts', () => ({ openStoredSession: vi.fn(), runSlash: vi.fn(), sendPrompt: vi.fn() }))
vi.mock('../store/windows.ts', () => ({ openApp: vi.fn(), showPage: vi.fn() }))

import { setupCommands } from '../commands/setup.ts'
import { $setupRequested } from '../store/setup.ts'
import { defineCommands, resetCommands } from '../store/os-commands.ts'
import { CommandPalette } from './CommandBar.tsx'

beforeAll(() => {
  // cmdk scrolls the selected item into view and observes the list; jsdom has neither.
  Element.prototype.scrollIntoView = vi.fn()
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

beforeEach(() => {
  resetCommands()
  defineCommands(setupCommands)
  $setupRequested.set(false)
})

afterEach(() => {
  cleanup()
})

async function openOnSetup() {
  const onClose = vi.fn()

  render(<CommandPalette onClose={onClose} />)

  const input = screen.getByPlaceholderText(/ask hermes anything/i)

  fireEvent.change(input, { target: { value: 'setup wizard' } })

  const item = await screen.findByText('Open the setup wizard')

  return { onClose, input, item }
}

describe('the command bar runs the command that was chosen', () => {
  it('lists "Open the setup wizard" when asked for the setup wizard', async () => {
    const { item } = await openOnSetup()

    expect(item).toBeTruthy()
  })

  it('runs setup.open and closes when the item is clicked', async () => {
    const { onClose, item } = await openOnSetup()

    fireEvent.click(item)

    await waitFor(() => expect($setupRequested.get()).toBe(true))
    expect(onClose).toHaveBeenCalled()
  })

  it('runs the highlighted command on Enter', async () => {
    const { onClose, input } = await openOnSetup()
    const doItem = (await screen.findByText('Open the setup wizard')).closest('[cmdk-item]') as HTMLElement

    // The "Ask Hermes" row is first; arrow down to the command, as a person would.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => expect(doItem.getAttribute('data-selected')).toBe('true'))
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect($setupRequested.get()).toBe(true))
    expect(onClose).toHaveBeenCalled()
  })
})
