import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, desktopCapturer: {}, screen: {}, shell: {} }))

const { ffmpegCandidates, recordingArgs, sourceForDisplay } = await import('./windows-capture.ts')

describe('ffmpegCandidates', () => {
  it('tries PATH first, then the newest ffmpeg Hermes shipped, then its bin folder', () => {
    const home = path.join('C:', 'Users', 'x', 'hermes')
    const tools = path.join('opt', 'tools')
    const other = path.join('opt', 'other')
    const list = ffmpegCandidates([tools, '', other].join(path.delimiter), home, () => ['node-26', 'ffmpeg-8.0.0-win32-x64', 'ffmpeg-9.0.1-win32-x64'])

    expect(list).toEqual([
      path.join(tools, 'ffmpeg.exe'),
      path.join(other, 'ffmpeg.exe'),
      path.join(home, 'tools', 'ffmpeg-9.0.1-win32-x64', 'bin', 'ffmpeg.exe'),
      path.join(home, 'tools', 'ffmpeg-8.0.0-win32-x64', 'bin', 'ffmpeg.exe'),
      path.join(home, 'bin', 'ffmpeg.exe')
    ])
  })
})

describe('recordingArgs', () => {
  it('grabs the desktop to a fragmented, even-sized H.264 MP4 at the end of the argument list', () => {
    const args = recordingArgs('out/rec.mp4', 24)

    expect(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2)).toEqual(['-f', 'gdigrab'])
    expect(args[args.indexOf('-framerate') + 1]).toBe('24')
    expect(args).toContain('libx264')
    expect(args[args.indexOf('-movflags') + 1]).toContain('empty_moov')
    expect(args[args.indexOf('-vf') + 1]).toContain('trunc(iw/2)*2')
    expect(args[args.length - 1]).toBe('out/rec.mp4')
  })
})

describe('sourceForDisplay', () => {
  const source = (id: string) => ({ display_id: id, thumbnail: { isEmpty: () => false, toPNG: () => Buffer.alloc(0) } })

  it('matches by display id and falls back to the only source', () => {
    expect(sourceForDisplay([source('1'), source('2')], { id: 2 })?.display_id).toBe('2')
    expect(sourceForDisplay([source('')], { id: 7 })?.display_id).toBe('')
    expect(sourceForDisplay([source('1'), source('2')], { id: 9 })).toBeUndefined()
  })
})
