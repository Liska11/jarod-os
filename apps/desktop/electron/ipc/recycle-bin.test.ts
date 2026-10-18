import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { isRecycleBin, RECYCLE_BIN, trashTarget } from '../../shared/trash.ts'
import { openRecycleBin } from './recycle-bin.ts'

function fakeSpawn(outcome: 'spawn' | 'error') {
  const calls: { command: string; args: string[]; options: unknown }[] = []
  const start = (command: string, args: string[], options: never) => {
    const child = new EventEmitter() as EventEmitter & { unref(): void; unrefs: number }
    child.unrefs = 0
    child.unref = () => void child.unrefs++
    calls.push({ command, args, options })
    queueMicrotask(() => (outcome === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('spawn explorer.exe ENOENT'))))

    return child as never
  }

  return { calls, start }
}

describe('trashTarget / isRecycleBin', () => {
  it('names the right place on each platform, and the Recycle Bin on Windows (not a Linux path)', () => {
    expect(trashTarget('darwin')).toBe('~/.Trash')
    expect(trashTarget('win32')).toBe('shell:RecycleBinFolder')
    expect(trashTarget('linux')).toBe('~/.local/share/Trash/files')
    expect(trashTarget('unknown')).toBe('~/.local/share/Trash/files')
  })

  it('accepts the shell location only on Windows', () => {
    expect(isRecycleBin(RECYCLE_BIN, 'win32')).toBe(true)
    expect(isRecycleBin(RECYCLE_BIN, 'linux')).toBe(false)
    expect(isRecycleBin('shell:Startup', 'win32')).toBe(false)
    expect(isRecycleBin('C:\\shell:RecycleBinFolder', 'win32')).toBe(false)
  })
})

describe('openRecycleBin', () => {
  it('starts Explorer on the shell location, detached, and resolves once it has started', async () => {
    const { calls, start } = fakeSpawn('spawn')

    await openRecycleBin(start as never)

    expect(calls).toEqual([{ command: 'explorer.exe', args: ['shell:RecycleBinFolder'], options: { detached: true, stdio: 'ignore', windowsHide: false } }])
  })

  it('says why when Explorer cannot start', async () => {
    const { start } = fakeSpawn('error')

    await expect(openRecycleBin(start as never)).rejects.toThrow('Could not open the Recycle Bin: spawn explorer.exe ENOENT')
  })
})
