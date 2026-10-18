import { atom } from 'nanostores'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()
const $prefs = atom({ voice: { duplex: true, enabled: true } })
const updatePrefs = vi.fn(async (patch: { voice: { duplex: boolean; enabled: boolean } }) => $prefs.set({ ...$prefs.get(), ...patch }))

vi.mock('./backend.ts', () => ({ $prefs, updatePrefs: (patch: { voice: { duplex: boolean; enabled: boolean } }) => updatePrefs(patch) }))
vi.mock('../lib/i18n.ts', () => ({ t: (key: string) => key }))
vi.mock('./notifications.ts', () => ({ notify: (...args: unknown[]) => notify(...args) }))

const { $echoFallback, isDuplexActive, noteEmptyBargeIn, noteHeardBargeIn, resetEchoGuard, setDuplex } = await import('./voice-echo.ts')
const prefs = () => $prefs.get().voice as never

describe('echo reaction', () => {
  beforeEach(() => {
    resetEchoGuard()
    notify.mockClear()
    updatePrefs.mockClear()
    $prefs.set({ voice: { duplex: true, enabled: true } })
  })

  it('switches this run to classic after three empty interruptions, says so once, leaves the saved choice alone', () => {
    noteEmptyBargeIn(0)
    noteEmptyBargeIn(5_000)
    expect(isDuplexActive(prefs())).toBe(true)
    noteEmptyBargeIn(10_000)

    expect($echoFallback.get()).toBe(true)
    expect(isDuplexActive(prefs())).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    const [input] = notify.mock.calls[0] as [{ actions: Array<{ command: string; args: { enabled: boolean } }> }]
    expect(input.actions.map(a => [a.command, a.args.enabled])).toEqual([
      ['voice.duplex.set', true],
      ['voice.duplex.set', false]
    ])
    expect(updatePrefs).not.toHaveBeenCalled()
  })

  it('does not switch when interruptions hold real words in between', () => {
    noteEmptyBargeIn(0)
    noteEmptyBargeIn(1_000)
    noteHeardBargeIn()
    noteEmptyBargeIn(2_000)

    expect($echoFallback.get()).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('back to duplex is saved and never prompts again in this run', async () => {
    for (const at of [0, 1_000, 2_000]) noteEmptyBargeIn(at)
    await setDuplex(true)

    expect($echoFallback.get()).toBe(false)
    expect(isDuplexActive(prefs())).toBe(true)
    for (const at of [3_000, 4_000, 5_000, 6_000]) noteEmptyBargeIn(at)
    expect($echoFallback.get()).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('keeping classic saves duplex off', async () => {
    for (const at of [0, 1_000, 2_000]) noteEmptyBargeIn(at)
    await setDuplex(false)

    expect(updatePrefs).toHaveBeenCalledWith({ voice: { duplex: false, enabled: true } })
    expect($echoFallback.get()).toBe(false)
    expect(isDuplexActive(prefs())).toBe(false)
  })
})
