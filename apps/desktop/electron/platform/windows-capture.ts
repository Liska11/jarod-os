import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import path from 'node:path'
import { clipboard, ClipboardItem, desktopCapturer, type Display, screen, shell } from 'electron'
import { hermesHome } from '../paths.ts'

/*
 * Screenshots and screen recording on Windows. The whole screen comes from Electron's own capturer;
 * a region or a window from Windows's Snipping Tool (the person draws on screen, the result lands on
 * the clipboard); recordings from the ffmpeg that Hermes ships (GDI grab).
 */

/** ffmpeg from PATH, else the copy in Hermes's tools folder (`tools/ffmpeg-<version>-<platform>/bin`). */
export function ffmpegCandidates(pathEnv: string, home: string, listTools: () => string[]): string[] {
  const fromPath = pathEnv.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'ffmpeg.exe'))
  const shipped = listTools()
    .filter(name => name.startsWith('ffmpeg-'))
    .sort()
    .reverse()
    .map(name => path.join(home, 'tools', name, 'bin', 'ffmpeg.exe'))

  return [...fromPath, ...shipped, path.join(home, 'bin', 'ffmpeg.exe')]
}

export function ffmpegPath(): string | null {
  const home = hermesHome()
  const candidates = ffmpegCandidates(process.env.PATH ?? process.env.Path ?? '', home, () => {
    try {
      return fsSync.readdirSync(path.join(home, 'tools'))
    } catch {
      return []
    }
  })

  return candidates.find(candidate => fsSync.existsSync(candidate)) ?? null
}

/**
 * Whole-desktop recording to a fragmented MP4, so a file that is cut short (a crash, a forced kill)
 * still plays. H.264 4:2:0 needs even dimensions, hence the crop to an even size.
 */
export function recordingArgs(file: string, framerate = 30): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'gdigrab', '-framerate', String(framerate), '-draw_mouse', '1', '-i', 'desktop',
    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-movflags', '+frag_keyframe+empty_moov',
    file
  ]
}

interface SourceLike {
  display_id: string
  thumbnail: { isEmpty(): boolean; toPNG(): Buffer }
}

/** The capturer source that is this display's screen. */
export function sourceForDisplay<T extends SourceLike>(sources: T[], display: Pick<Display, 'id'>): T | undefined {
  return sources.find(source => source.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
}

/** The primary display, at its real pixel size, as a PNG file. */
export async function captureScreenTo(file: string): Promise<boolean> {
  const display = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
  })
  const source = sourceForDisplay(sources, display)

  if (!source || source.thumbnail.isEmpty()) {
    return false
  }

  fsSync.writeFileSync(file, source.thumbnail.toPNG())

  return true
}

const sha = (buffer: Buffer): string => crypto.createHash('sha1').update(buffer).digest('hex')

/** The image on the clipboard as PNG bytes, or null when there is none. */
export async function readClipboardPng(): Promise<Buffer | null> {
  try {
    for (const item of await clipboard.read()) {
      if (item.types.includes('image/png')) {
        return Buffer.from(await (await item.getType('image/png')).arrayBuffer())
      }
    }
  } catch {
    // Nothing readable on the clipboard.
  }

  return null
}

async function writeClipboardPng(png: Buffer): Promise<void> {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

function running(image: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', chunk => (out += String(chunk)))
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(out.toLowerCase().includes(image.toLowerCase())))
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Open the Snipping Tool's selection and save what the person selects as a PNG. False when they cancel.
 * The tool puts the result on the clipboard, so the clipboard is the way back: a new image there
 * after the overlay closes is the selection (the previous clipboard image is put back afterwards).
 */
export async function snipTo(file: string, timeoutMs = 120_000): Promise<boolean> {
  const before = await readClipboardPng()
  const beforeHash = before ? sha(before) : ''
  const started = Date.now()
  await shell.openExternal('ms-screenclip:')

  // A new image on the clipboard is the selection. The tool may stay open afterwards (Windows 11
  // keeps its window), so only its process going away without an image means the person cancelled.
  let seen = false
  let after: Buffer | null = null

  while (Date.now() - started < timeoutMs) {
    const image = await readClipboardPng()

    if (image && sha(image) !== beforeHash) {
      after = image
      break
    }

    const open = (await running('ScreenClippingHost.exe')) || (await running('SnippingTool.exe'))

    if (open) {
      seen = true
    } else if (seen) {
      // Gone: give the clipboard a moment to receive the result, then look once more.
      await sleep(800)
      const last = await readClipboardPng()
      after = last && sha(last) !== beforeHash ? last : null
      break
    }

    await sleep(300)
  }

  if (!after) {
    return false
  }

  fsSync.writeFileSync(file, after)

  if (before) {
    await writeClipboardPng(before)
  } else {
    clipboard.clear()
  }

  return true
}
