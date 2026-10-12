import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.fn()

vi.mock('../store/notifications.ts', () => ({ notify: (...args: unknown[]) => notify(...args) }))

const { attempt, quietly } = await import('./native.ts')

describe('attempt', () => {
  beforeEach(() => {
    notify.mockReset()
  })

  it('says nothing when the call works', async () => {
    await attempt('open the file', () => Promise.resolve())

    expect(notify).not.toHaveBeenCalled()
  })

  it('turns a refusal into a notification with the reason, and does not reject', async () => {
    await attempt('open the file', () => Promise.reject(new Error('ENOENT: no such file')))

    expect(notify).toHaveBeenCalledWith({ title: 'Could not open the file', body: 'ENOENT: no such file', level: 'error' })
  })

  it('also catches a call that throws before returning a promise (the bridge is missing)', async () => {
    await attempt('open the link', () => {
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
