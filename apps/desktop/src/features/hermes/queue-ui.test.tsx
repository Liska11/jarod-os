// @vitest-environment jsdom
/**
 * La file de messages vue de la fenêtre : la bande au-dessus du composer, et ce que le composer fait d'Entrée et de Ctrl+Entrée
 * pendant que l'agent travaille. Le gateway est une doublure ; ce qu'on vérifie, c'est ce que l'écran en fait.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const call = vi.fn()

vi.mock('../../store/gateway.ts', () => ({
  gatewayRequest: vi.fn(),
  gatewayCall: (...args: unknown[]) => call(...args),
  onAnyGatewayEvent: () => () => undefined
}))
vi.mock('../voice/MicButton.tsx', () => ({ MicButton: () => null }))

const { $activeChatId, $chats, $queues, resetChats } = await import('../../store/chat.ts')
const { appendUser, emptyChat } = await import('../../lib/chat-model.ts')
const { QueueStrip } = await import('./QueueStrip.tsx')
const { HermesComposer } = await import('./HermesComposer.tsx')

beforeEach(() => {
  // jsdom has no ResizeObserver; the composer measures its textarea with one.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  call.mockReset()
  call.mockResolvedValue({})
  resetChats()
})

afterEach(cleanup)

function openChat(streaming: boolean) {
  const base = emptyChat('s1', 'stored-1')
  $chats.setKey('s1', streaming ? appendUser(base, 'first') : base)
  $activeChatId.set('s1')
}

const queued = (...texts: string[]) => $queues.setKey('s1', texts.map((text, i) => ({ id: `q${i}`, text, at: i })))

describe('QueueStrip', () => {
  it('shows nothing when no message is waiting', () => {
    openChat(true)
    const { container } = render(<QueueStrip />)

    expect(container.innerHTML).toBe('')
  })

  it('lists the waiting messages in order while the agent works, without offering to resume', () => {
    openChat(true)
    queued('then this', 'and that')
    render(<QueueStrip />)

    expect(screen.getByText('Queued (2)')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['1then this', '2and that'])
    expect(screen.queryByText('Resume')).toBeNull()
  })

  it('when no turn is running but messages remain, says the queue is paused and offers to resume it', () => {
    openChat(false)
    queued('stuck')
    render(<QueueStrip />)

    expect(screen.getByText('Paused after a stopped or failed turn')).toBeTruthy()

    fireEvent.click(screen.getByText('Resume'))
    expect(call).toHaveBeenCalledWith('prompt.queue.resume', { session_id: 's1' })
  })

  it('removes one message or clears the whole queue through the gateway', () => {
    openChat(true)
    queued('a', 'b')
    render(<QueueStrip />)

    fireEvent.click(screen.getAllByLabelText('Remove from the queue')[1]!)
    expect(call).toHaveBeenCalledWith('prompt.queue.remove', { session_id: 's1', id: 'q1' })

    fireEvent.click(screen.getByText('Clear'))
    expect(call).toHaveBeenCalledWith('prompt.queue.clear', { session_id: 's1' })
  })

  it('follows the store when the gateway pushes a new list', () => {
    openChat(true)
    render(<QueueStrip />)

    act(() => queued('late arrival'))
    expect(screen.getByText('late arrival')).toBeTruthy()

    act(() => queued())
    expect(screen.queryByText('late arrival')).toBeNull()
  })
})

describe('HermesComposer while the agent works', () => {
  const setup = (streaming: boolean) => {
    const onSubmit = vi.fn()
    const onSteer = vi.fn()
    const onInterrupt = vi.fn()
    render(<HermesComposer streaming={streaming} onSubmit={onSubmit} onSteer={onSteer} onInterrupt={onInterrupt} />)

    return { onSubmit, onSteer, onInterrupt, box: screen.getByRole('textbox') as HTMLTextAreaElement }
  }

  it('Enter sends (the page queues it) and Ctrl+Enter steers the turn in progress', () => {
    const { onSubmit, onSteer, box } = setup(true)

    fireEvent.change(box, { target: { value: 'queue me' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('queue me')

    fireEvent.change(box, { target: { value: 'steer me' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    expect(onSteer).toHaveBeenCalledWith('steer me')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('with the agent idle, Ctrl+Enter is just Enter: there is nothing to steer', () => {
    const { onSubmit, onSteer, box } = setup(false)

    fireEvent.change(box, { target: { value: 'hello' } })
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })

    expect(onSubmit).toHaveBeenCalledWith('hello')
    expect(onSteer).not.toHaveBeenCalled()
  })

  it('shows Steer and Queue next to Stop once something is typed, and Stop alone otherwise', () => {
    const { box, onSteer } = setup(true)

    expect(screen.getByLabelText('Stop')).toBeTruthy()
    expect(screen.queryByLabelText('Steer')).toBeNull()
    expect(screen.queryByLabelText('Queue')).toBeNull()

    fireEvent.change(box, { target: { value: 'something' } })
    expect(screen.getByLabelText('Queue')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Steer'))
    expect(onSteer).toHaveBeenCalledWith('something')
    expect(box.value).toBe('')
  })

  it('the Stop button still interrupts', () => {
    const { onInterrupt } = setup(true)

    fireEvent.click(screen.getByLabelText('Stop'))
    expect(onInterrupt).toHaveBeenCalled()
  })

  it('invites the user to write while the agent works', () => {
    const { box } = setup(true)

    expect(box.placeholder).toBe('Write now: Enter queues it, Ctrl+Enter steers…')
  })
})
