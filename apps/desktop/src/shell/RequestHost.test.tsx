// @vitest-environment jsdom
/**
 * V-20 (upstream #172): an approval card never puts the focus on one of its answers. A card that arrives while someone types leaves
 * the field focused (a stray Enter cannot approve); with nothing being typed, the card itself takes the focus; and each queued request
 * gets a new card, so the focus never lands on the next approval's button after the first is answered.
 */

import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { $pendingRequests, type PendingRequest } from '../store/requests.ts'
import { RequestHost } from './RequestHost.tsx'

vi.mock('../store/gateway.ts', () => ({ gatewayRequest: vi.fn(), onAnyGatewayEvent: vi.fn(), onGatewayEvent: vi.fn(), onServerRequest: vi.fn() }))

const approval = (id: string, respond = vi.fn()): PendingRequest => ({
  kind: 'approval',
  request: { id, kind: 'approval', params: { command: `echo ${id}`, description: `step ${id}`, choices: ['once', 'deny'] }, respond } as never,
  receivedAt: Date.now()
})

const card = (id: string) => document.querySelector<HTMLElement>(`[data-request-card="${id}"]`)!

afterEach(() => {
  act(() => $pendingRequests.set([]))
  cleanup()
  document.body.innerHTML = ''
})

describe('RequestHost focus (V-20)', () => {
  it('a card arriving while a field is being typed in leaves the field focused; Enter there answers nothing', () => {
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    const respond = vi.fn()
    render(<RequestHost />)
    act(() => $pendingRequests.set([approval('a', respond)]))

    expect(document.activeElement).toBe(field)
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(respond).not.toHaveBeenCalled()
    expect($pendingRequests.get()).toHaveLength(1)
  })

  it('with nothing being typed, the card itself takes the focus — never an answer — and Enter on it answers nothing', () => {
    const respond = vi.fn()
    render(<RequestHost />)
    act(() => $pendingRequests.set([approval('a', respond)]))

    expect(document.activeElement).toBe(card('a'))
    expect(document.activeElement?.tagName).not.toBe('BUTTON')
    fireEvent.keyDown(card('a'), { key: 'Enter' })
    fireEvent.keyDown(card('a'), { key: ' ' })
    expect(respond).not.toHaveBeenCalled()
  })

  it('each queued approval is a new card: answering the first never leaves the focus on the second one’s button', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<RequestHost />)
    act(() => $pendingRequests.set([approval('a', first), approval('b', second)]))
    const answers = within(card('a')).getAllByRole('button')
    answers[0]!.focus()
    act(() => answers[0]!.click())

    expect(first).toHaveBeenCalledWith({ choice: 'once' })
    expect(card('b')).toBeTruthy()
    expect(card('a')).toBeNull()
    expect(within(card('b')).getAllByRole('button')).not.toContain(document.activeElement)
    expect(second).not.toHaveBeenCalled()
  })

  it('the secret field no longer takes the focus by itself', () => {
    const field = document.createElement('textarea')
    document.body.append(field)
    field.focus()
    render(<RequestHost />)
    act(() =>
      $pendingRequests.set([{ kind: 'secret', request: { id: 's', kind: 'secret', params: { env_var: 'X_KEY', prompt: '' }, respond: vi.fn() } as never, receivedAt: Date.now() }])
    )

    expect(document.activeElement).toBe(field)
  })

  it('when the card goes, the focus returns to where it was', () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    render(<RequestHost />)
    act(() => $pendingRequests.set([approval('a')]))
    expect(document.activeElement).toBe(card('a'))
    act(() => $pendingRequests.set([]))

    expect(document.activeElement).toBe(before)
  })
})
