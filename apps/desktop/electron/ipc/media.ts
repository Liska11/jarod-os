import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ipcMain, protocol } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'

/*
 * The Player page streams local files through `jarod-media://local/<base64url path>`, and only the files the user
 * picked or dropped there (IPC.mediaAllow). Byte ranges are honoured, so a long video seeks without being read whole.
 */

export const MEDIA_SCHEME = 'jarod-media'

const allowed = new Set<string>()

export function mediaUrl(file: string): string {
  return `${MEDIA_SCHEME}://local/${Buffer.from(file, 'utf8').toString('base64url')}`
}

export function fileOfMediaUrl(url: string): string | null {
  try {
    const parsed = new URL(url)

    if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.hostname !== 'local') {
      return null
    }

    return Buffer.from(parsed.pathname.replace(/^\//, ''), 'base64url').toString('utf8') || null
  } catch {
    return null
  }
}

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.vtt': 'text/vtt',
  '.srt': 'text/plain; charset=utf-8'
}

/** `bytes=a-b` → the inclusive range within `size`; null when absent or unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null

  if (!match || (!match[1] && !match[2])) {
    return null
  }

  let start: number
  let end: number

  if (!match[1]) {
    // A suffix: the last N bytes.
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }

  return start <= end && start < size ? { start, end } : null
}

async function serve(request: Request): Promise<Response> {
  const file = fileOfMediaUrl(request.url)
  const real = file ? await fs.promises.realpath(file).catch(() => null) : null

  if (!real || !allowed.has(real)) {
    return new Response(null, { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })
  }

  const stat = await fs.promises.stat(real).catch(() => null)

  if (!stat?.isFile()) {
    return new Response(null, { status: 404 })
  }

  const type = TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream'
  const range = parseRange(request.headers.get('range'), stat.size)
  // The shell's page reads subtitles with fetch; only the default session (the shell) has this scheme.
  const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length' })

  if (request.headers.get('range') && !range) {
    headers.set('Content-Range', `bytes */${stat.size}`)

    return new Response(null, { status: 416, headers })
  }

  const { start, end } = range ?? { start: 0, end: Math.max(0, stat.size - 1) }
  headers.set('Content-Length', String(stat.size === 0 ? 0 : end - start + 1))

  if (range) {
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  }

  const body = stat.size === 0 ? null : (Readable.toWeb(fs.createReadStream(real, { start, end })) as ReadableStream)

  return new Response(body, { status: range ? 206 : 200, headers })
}

/** Must run before the app is ready (with the other privileged schemes). */
export const MEDIA_SCHEME_PRIVILEGES: Electron.CustomScheme = { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }

export function registerMediaIpc(): void {
  protocol.handle(MEDIA_SCHEME, request => serve(request))
  ipcMain.handle(IPC.mediaAllow, async (_event, files: unknown): Promise<Array<{ file: string; url: string }>> => {
    const list = Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string' && path.isAbsolute(file)).slice(0, 500) : []
    const out: Array<{ file: string; url: string }> = []

    for (const file of list) {
      const real = await fs.promises.realpath(file).catch(() => null)
      const stat = real ? await fs.promises.stat(real).catch(() => null) : null

      if (real && stat?.isFile()) {
        allowed.add(real)
        out.push({ file, url: mediaUrl(real) })
      }
    }

    log('media', `allowed ${out.length} file(s) for the player`)

    return out
  })
}
