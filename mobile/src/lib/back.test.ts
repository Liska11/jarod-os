import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('back layers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', {})
  })

  it('closes the top layer first, one gesture at a time', async () => {
    const { openLayer, goBack, openLayers } = await import('./back.ts')
    const closed: string[] = []
    openLayer(() => closed.push('page'))
    openLayer(() => closed.push('sheet'))
    expect(openLayers()).toBe(2)
    expect(goBack()).toBe(true)
    expect(closed).toEqual(['sheet'])
    expect(goBack()).toBe(true)
    expect(closed).toEqual(['sheet', 'page'])
    expect(openLayers()).toBe(0)
  })

  it('lets the app leave when nothing is open', async () => {
    const { goBack } = await import('./back.ts')
    expect(goBack()).toBe(false)
  })

  it('forgets a layer the page closed itself', async () => {
    const { openLayer, goBack, openLayers } = await import('./back.ts')
    const closed: string[] = []
    openLayer(() => closed.push('page'))
    const dispose = openLayer(() => closed.push('sheet'))
    dispose()
    expect(openLayers()).toBe(1)
    expect(goBack()).toBe(true)
    expect(closed).toEqual(['page'])
    dispose()
    expect(goBack()).toBe(false)
  })

  it('answers the native side through window.__jarodBack', async () => {
    const { openLayer, installBackHook } = await import('./back.ts')
    installBackHook()
    const hook = (window as unknown as { __jarodBack: () => boolean }).__jarodBack
    expect(hook()).toBe(false)
    const closed: string[] = []
    openLayer(() => closed.push('sheet'))
    expect(hook()).toBe(true)
    expect(closed).toEqual(['sheet'])
  })

  it('closes a layer once, even if closing it opens the next', async () => {
    const { openLayer, goBack } = await import('./back.ts')
    const closed: string[] = []
    openLayer(() => {
      closed.push('first')
      openLayer(() => closed.push('second'))
    })
    expect(goBack()).toBe(true)
    expect(closed).toEqual(['first'])
    expect(goBack()).toBe(true)
    expect(closed).toEqual(['first', 'second'])
  })
})
