import { describe, expect, it } from 'vitest'
import { addToPlaylist, fileName, formatTime, isAudio, isMedia, nextIndex, previousIndex, srtToVtt, toVtt } from './player-model.ts'

describe('player files', () => {
  it('takes videos and music, tells music apart', () => {
    expect(isMedia('C:\\Films\\a.MKV')).toBe(true)
    expect(isMedia('C:\\notes.txt')).toBe(false)
    expect(isAudio('/m/song.flac')).toBe(true)
    expect(isAudio('/m/clip.mp4')).toBe(false)
    expect(fileName('C:\\Films\\a.mkv')).toBe('a.mkv')
  })

  it('adds media once, in order', () => {
    expect(addToPlaylist(['a.mp4'], ['b.mp3', 'a.mp4', 'c.txt', 'b.mp3', 'd.webm'])).toEqual(['a.mp4', 'b.mp3', 'd.webm'])
  })
})

describe('subtitles', () => {
  it('turns SubRip into WebVTT', () => {
    const srt = '\uFEFF1\r\n00:00:01,500 --> 00:00:03,250\r\nBonjour\r\n'

    expect(srtToVtt(srt)).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.250\nBonjour\n')
  })

  it('leaves WebVTT as it is', () => {
    expect(toVtt('WEBVTT\n\nx', 'a.vtt')).toBe('WEBVTT\n\nx')
  })
})

describe('playlist order', () => {
  it('stops at the end unless the playlist repeats', () => {
    expect(nextIndex(0, 3, false)).toBe(1)
    expect(nextIndex(2, 3, false)).toBeNull()
    expect(nextIndex(2, 3, true)).toBe(0)
    expect(nextIndex(0, 0, true)).toBeNull()
    expect(previousIndex(0, 3)).toBe(0)
    expect(previousIndex(2, 3)).toBe(1)
  })

  it('formats times', () => {
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatTime(Number.NaN)).toBe('0:00')
  })
})
