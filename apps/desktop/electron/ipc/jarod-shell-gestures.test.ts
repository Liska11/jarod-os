import { describe, expect, it, vi } from 'vitest'
import { installSummaryText, type NativeDialogs, type NativeEffects, runNativeGesture } from './jarod-shell-gestures.ts'

function rig(answers: { open?: string | null; save?: string | null; button?: number } = {}) {
  const dialogs = {
    open: vi.fn(async () => answers.open ?? null),
    save: vi.fn(async () => answers.save ?? null),
    message: vi.fn(async () => answers.button ?? -1)
  } satisfies NativeDialogs
  const effects = {
    writeClipboard: vi.fn(),
    openExternal: vi.fn(async () => {}),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    setThemeSource: vi.fn(),
    quit: vi.fn(),
    relaunch: vi.fn(),
    restartBackend: vi.fn(),
    browser: vi.fn(async () => ({ ok: true }))
  } satisfies NativeEffects

  return { dialogs, effects, run: (kind: string, params: Record<string, unknown> = {}) => runNativeGesture(kind, params, dialogs, effects) }
}

describe('pickers', () => {
  it('a file picker passes only well-formed filters; a cancelled dialog is null', async () => {
    const r = rig({ open: 'C:\\m\\a.gguf' })

    expect(await r.run('pickFile', { title: 'Model', filters: [{ name: 'GGUF', extensions: ['gguf'] }, { name: 'bad', extensions: ['../x', 3] }, 'junk', { extensions: ['a'] }] })).toBe('C:\\m\\a.gguf')
    expect(r.dialogs.open).toHaveBeenCalledWith({ title: 'Model', properties: ['openFile'], filters: [{ name: 'GGUF', extensions: ['gguf'] }] })
    expect(await rig().run('pickFile')).toBeNull()
    expect(await rig().run('pickFolder')).toBeNull()
  })

  it('a destination folder carries its title and starting folder; a save path its suggested name', async () => {
    const r = rig({ open: 'D:\\models', save: 'D:\\out.zip' })

    expect(await r.run('pickDestinationFolder', { title: 'Where?', defaultPath: 'D:\\' })).toBe('D:\\models')
    expect(r.dialogs.open).toHaveBeenCalledWith({ title: 'Where?', properties: ['openDirectory', 'createDirectory'], defaultPath: 'D:\\' })
    expect(await r.run('pickSavePath', { defaultName: 'backup.zip' })).toBe('D:\\out.zip')
    expect(r.dialogs.save).toHaveBeenCalledWith({ defaultPath: 'backup.zip' })
  })
})

describe('consent', () => {
  it('confirm is true ONLY when the action button (index 0) was pressed; Cancel is the default', async () => {
    for (const [button, expected] of [[0, true], [1, false], [-1, false], [2, false]] as const) {
      const r = rig({ button })

      expect(await r.run('confirm', { message: 'Sure?', detail: 'x', action: 'Restore' })).toBe(expected)
      expect(r.dialogs.message).toHaveBeenCalledWith({ type: 'question', message: 'Sure?', detail: 'x', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1 })
    }
  })

  it('an install shows what, from where, licence, hash, permissions; consent only on Install', async () => {
    const summary = { kind: 'skill', id: 'a', name: 'Resume', source: 'registry', revision: 'abc123', license: 'MIT', sha256: 'f00d', permissions: ['read files', 'network'], files: 3, target: 'C:\\profile\\skills\\resume' }
    const text = installSummaryText(summary)

    expect(text.message).toBe('Install skill “Resume”?')
    for (const needle of ['registry', 'abc123', 'MIT', 'f00d', 'read files', 'network', '3', 'C:\\profile\\skills\\resume']) expect(text.detail).toContain(needle)

    const yes = rig({ button: 0 })
    const no = rig({ button: 1 })

    expect(await yes.run('confirmInstall', { summary })).toBe(true)
    expect(await no.run('confirmInstall', { summary })).toBe(false)
    expect((yes.dialogs.message.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).toMatchObject({ type: 'warning', buttons: ['Install', 'Cancel'], defaultId: 1 })
  })

  it('garbage in the summary does not throw and does not grant anything', async () => {
    expect(installSummaryText(null).message).toMatch(/^Install\s+“”\?$/)
    expect(await rig({ button: 1 }).run('confirmInstall', { summary: 42 })).toBe(false)
  })
})

describe('effects', () => {
  it('opens only http(s) and mailto links', async () => {
    const r = rig()

    expect(await r.run('openExternal', { url: 'https://example.org/a' })).toBe(true)
    expect(await r.run('openExternal', { url: 'mailto:a@b.c' })).toBe(true)
    expect(r.effects.openExternal).toHaveBeenCalledTimes(2)

    for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', '', 'C:\\x.exe']) {
      await expect(r.run('openExternal', { url })).rejects.toThrow(/only http/)
    }

    expect(r.effects.openExternal).toHaveBeenCalledTimes(2)
  })

  it('clipboard, theme (closed list), reveal, quit/relaunch; an unknown gesture throws', async () => {
    const r = rig()

    await r.run('clipboard', { text: 'hello' })
    expect(r.effects.writeClipboard).toHaveBeenCalledWith('hello')
    await r.run('themeSource', { source: 'dark' })
    await r.run('themeSource', { source: 'rainbow' })
    expect(r.effects.setThemeSource.mock.calls).toEqual([['dark']])
    await r.run('showItemInFolder', { path: 'C:\\a' })
    expect(r.effects.showItemInFolder).toHaveBeenCalledWith('C:\\a')
    await r.run('quit')
    await r.run('relaunch')
    expect([r.effects.quit.mock.calls.length, r.effects.relaunch.mock.calls.length]).toEqual([1, 1])
    expect(await r.run('browser', { op: 'read', args: [] })).toEqual({ ok: true })
    expect(r.effects.browser).toHaveBeenCalledWith({ op: 'read', args: [] })
    expect(await r.run('restartBackend')).toBe(true)
    expect(r.effects.restartBackend).toHaveBeenCalledTimes(1)
    await expect(r.run('format-disk')).rejects.toThrow(/unknown gesture/)
  })

  it('openPath hands back the OS error text (empty = fine)', async () => {
    const r = rig()

    r.effects.openPath.mockResolvedValueOnce('no application')
    expect(await r.run('openPath', { path: 'C:\\x.bin' })).toBe('no application')
    expect(await r.run('openPath', { path: 'C:\\y.txt' })).toBe('')
  })
})
