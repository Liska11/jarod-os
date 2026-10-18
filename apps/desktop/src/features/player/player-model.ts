/** The Player page's pure parts: which files it takes, subtitles, the playlist order. */

export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'])
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'])
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set(['.srt', '.vtt'])

export function extension(file: string): string {
  const match = /(\.[^./\\]+)$/.exec(file)

  return match ? match[1].toLowerCase() : ''
}

export const isMedia = (file: string): boolean => MEDIA_EXTENSIONS.has(extension(file))
export const isAudio = (file: string): boolean => AUDIO_EXTENSIONS.has(extension(file))
export const isSubtitle = (file: string): boolean => SUBTITLE_EXTENSIONS.has(extension(file))

export function fileName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file
}

/** SubRip → WebVTT: the header, and a dot instead of the comma in each timing. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim()

  return `WEBVTT\n\n${body}\n`
}

export function toVtt(text: string, file: string): string {
  return extension(file) === '.vtt' ? text : srtToVtt(text)
}

/** The next track to play after `index`, or null at the end (repeat-all wraps around). */
export function nextIndex(index: number, length: number, repeatAll: boolean): number | null {
  if (length === 0) {
    return null
  }

  if (index + 1 < length) {
    return index + 1
  }

  return repeatAll ? 0 : null
}

export function previousIndex(index: number, length: number): number | null {
  return length === 0 ? null : index > 0 ? index - 1 : 0
}

/** Adds files to a playlist: media only, without the ones already there. */
export function addToPlaylist(playlist: readonly string[], files: readonly string[]): string[] {
  const seen = new Set(playlist)
  const added = files.filter(file => isMedia(file) && !seen.has(file) && (seen.add(file), true))

  return [...playlist, ...added]
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00'
  }

  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60) % 60
  const h = Math.floor(seconds / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')

  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
