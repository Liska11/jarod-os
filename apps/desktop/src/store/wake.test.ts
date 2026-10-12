import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
const ready = atom(true)
const prefs = atom({ voice: { enabled: true, wakeWord: true } })

vi.mock('./gateway.ts', () => ({ $gatewayReady: ready, gatewayRequest: (...args: unknown[]) => request(...args), onGatewayEvent: () => () => undefined }))
vi.mock('./backend.ts', () => ({ $prefs: prefs, updatePrefs: vi.fn() }))
vi.mock('./shell.ts', () => ({ isMainSurface: true }))
vi.mock('./notifications.ts', () => ({ notify: vi.fn() }))
vi.mock('./voice.ts', () => ({ startVoice: vi.fn() }))
vi.mock('../lib/voice/audio-capture.ts', () => ({ MicrophoneUnavailableError: class extends Error {}, subscribeMicrophone: vi.fn() }))
vi.mock('../lib/voice/earcons.ts', () => ({ earcons: { wake: vi.fn() } }))

const { $wake, bindWake } = await import('./wake.ts')

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('arming the wake word', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => void unhandled.push(reason)
  let unbind = () => {}

  beforeEach(() => {
    unhandled.length = 0
    request.mockReset()
    $wake.set({ listening: false, paused: false, phrase: 'hey hermes', capture: 'client', error: null })
    process.on('unhandledRejection', onUnhandled)
  })

  afterEach(() => {
    unbind()
    process.off('unhandledRejection', onUnhandled)
  })

  it('shows "Not available in this version" when the engine does not do wake words, with no unhandled rejection', async () => {
    request.mockRejectedValue(new Error('Not available in this version'))
    unbind = bindWake()
    await settle()

    expect($wake.get()).toMatchObject({ listening: false, error: 'Not available in this version' })
    expect(request).toHaveBeenCalledWith('wake.start', expect.anything())
    expect(unhandled).toEqual([])
  })

  it('reports any other failure with its own message', async () => {
    request.mockRejectedValue(new Error('socket closed'))
    unbind = bindWake()
    await settle()

    expect($wake.get()).toMatchObject({ listening: false, error: 'socket closed' })
    expect(unhandled).toEqual([])
  })
})
