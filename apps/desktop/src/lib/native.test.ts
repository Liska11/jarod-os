import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()

vi.mock('../store/notifications.ts', () => ({ notify: (...args: unknown[]) => notify(...args) }))

const { attempt, quietly } = await import('./native.ts')
const { $prefs } = await import('../store/backend.ts')

/** Every case starts in English; the French ones set the language and put it back. */
const as = (language: 'en' | 'fr') => $prefs.set({ ...$prefs.get(), language })

describe('attempt', () => {
  beforeEach(() => {
    notify.mockReset()
    as('en')
  })

  it('reports the failure in the interface language', async () => {
    as('fr')
    await attempt('native.failed.openFile', () => Promise.reject(new Error('ENOENT: no such file')))

    expect(notify).toHaveBeenCalledWith({ title: "Impossible d’ouvrir le fichier", body: 'ENOENT: no such file', level: 'error' })
  })

  it('says nothing when the call works', async () => {
    await attempt('native.failed.openFile', () => Promise.resolve())

    expect(notify).not.toHaveBeenCalled()
  })

  it('turns a refusal into a notification with the reason, and does not reject', async () => {
    await attempt('native.failed.openFile', () => Promise.reject(new Error('ENOENT: no such file')))

    expect(notify).toHaveBeenCalledWith({ title: 'Could not open the file', body: 'ENOENT: no such file', level: 'error' })
  })

  it('also catches a call that throws before returning a promise (the bridge is missing)', async () => {
    await attempt('native.failed.openLink', () => {
      throw new TypeError("Cannot read properties of undefined (reading 'shell')")
    })

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not open the link', level: 'error' }))
  })
})

describe('quietly', () => {
  it('swallows a failure and still resolves', async () => {
    await expect(quietly(() => Promise.reject(new Error('gone')))).resolves.toBeUndefined()
    await expect(
      quietly(() => {
        throw new Error('sync')
      })
    ).resolves.toBeUndefined()
  })
})
