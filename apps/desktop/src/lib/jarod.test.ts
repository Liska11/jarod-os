import { describe, expect, it, vi } from 'vitest'

vi.mock('../store/gateway.ts', () => ({ gatewayCall: vi.fn(), onAnyGatewayEvent: vi.fn(), onServerRequest: vi.fn() }))

const { answerShellRequest, dispatchJarodEvent, jarodEventOf, onJarodEvent } = await import('./jarod.ts')

describe('events', () => {
  it('parses a jarod.event payload and ignores anything else', () => {
    expect(jarodEventOf({ channel: 'local-engine-progress', args: [1, 2] })).toEqual({ channel: 'local-engine-progress', args: [1, 2] })

    for (const bad of [null, undefined, {}, { channel: 3, args: [] }, { channel: 'a' }, { channel: 'a', args: {} }]) {
      expect(jarodEventOf(bad)).toBeNull()
    }
  })

  it('delivers to the listeners of that channel only, until unsubscribed; one throwing listener does not stop the others', () => {
    const a = vi.fn()
    const b = vi.fn(() => {
      throw new Error('boom')
    })
    const c = vi.fn()
    const offA = onJarodEvent('x', a)

    onJarodEvent('x', b)
    onJarodEvent('x', c)
    onJarodEvent('y', vi.fn())
    vi.spyOn(console, 'error').mockImplementation(() => {})
    dispatchJarodEvent('x', [1, 'two'])
    expect([a.mock.calls, c.mock.calls]).toEqual([[[1, 'two']], [[1, 'two']]])
    offA()
    dispatchJarodEvent('x', [3])
    expect([a.mock.calls.length, c.mock.calls.length]).toEqual([1, 2])
  })
})

describe('answerShellRequest', () => {
  it('relays the gesture and wraps the answer; a failure or a missing answer is null (a refusal for the engine)', async () => {
    const perform = vi.fn(async (kind: string) => (kind === 'pickFile' ? 'C:\a.gguf' : undefined))

    expect(await answerShellRequest('pickFile', { title: 'Model' }, perform)).toEqual({ value: 'C:\a.gguf' })
    expect(perform).toHaveBeenCalledWith('pickFile', { title: 'Model' })
    expect(await answerShellRequest('confirm', {}, perform)).toEqual({ value: null })
    expect(await answerShellRequest('pickFile', {}, async () => { throw new Error('closed') })).toEqual({ value: null })
    expect(await answerShellRequest(42, {}, perform)).toEqual({ value: null })
    expect(await answerShellRequest('pickFile', 'junk', perform)).toEqual({ value: 'C:\a.gguf' })
    expect(perform).toHaveBeenLastCalledWith('pickFile', {})
  })
})
