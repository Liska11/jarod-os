import { describe, expect, it } from 'vitest'
import { SentenceSpeaker } from './sentence-speaker.ts'

/** Fake synthesis and playback: each piece is played until `release()`; nothing is real audio. */
function fakeAudio() {
  const log: string[] = []
  const pendingSynth: Array<{ text: string; resolve: (url: string) => void; reject: (error: Error) => void }> = []
  let releasePlay: (() => void) | null = null

  return {
    log,
    deps: {
      synth: (text: string) =>
        new Promise<string>((resolve, reject) => {
          log.push(`synth:${text}`)
          pendingSynth.push({ text, resolve, reject })
        }),
      play: (audio: string) =>
        new Promise<void>(resolve => {
          log.push(`play:${audio}`)
          releasePlay = resolve
        }),
      silence: () => {
        log.push('silence')
        releasePlay?.()
        releasePlay = null
      }
    },
    synthDone: async (index = 0) => {
      const item = pendingSynth.splice(index, 1)[0]
      item.resolve(`audio(${item.text})`)
      await flush()
    },
    synthFails: async () => {
      pendingSynth.shift()?.reject(new Error('TTS down'))
      await flush()
    },
    playDone: async () => {
      const release = releasePlay
      releasePlay = null
      release?.()
      await flush()
    },
    pending: () => pendingSynth.map(item => item.text)
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('SentenceSpeaker', () => {
  it('starts speaking the first sentence while the reply is still streaming, and synthesizes the next one meanwhile', async () => {
    const audio = fakeAudio()
    const events: string[] = []
    const speaker = new SentenceSpeaker(audio.deps, { onStart: () => events.push('start'), onEnd: reason => events.push(`end:${reason}`) })

    speaker.feed('Bonjour San. Voici ')
    expect(audio.pending()).toEqual(['Bonjour San.'])
    await audio.synthDone()
    expect(events).toEqual(['start'])
    expect(audio.log).toContain('play:audio(Bonjour San.)')

    speaker.feed('le résumé. Fin')
    expect(audio.pending()).toEqual(['Voici le résumé.'])
    speaker.done()
    expect(audio.pending()).toEqual(['Voici le résumé.', 'Fin'])

    await audio.synthDone()
    await audio.synthDone()
    await audio.playDone()
    await audio.playDone()
    await audio.playDone()
    expect(events).toEqual(['start', 'end:drained'])
    expect(speaker.heard()).toBe('Bonjour San. Voici le résumé. Fin')
  })

  it('a stop silences at once, and a synthesis landing after it never plays (no old reply comes back)', async () => {
    const audio = fakeAudio()
    const events: string[] = []
    const speaker = new SentenceSpeaker(audio.deps, { onEnd: reason => events.push(`end:${reason}`) })

    speaker.feed('Première phrase. Deuxième phrase. ')
    await audio.synthDone()
    speaker.stop()
    expect(audio.log).toContain('silence')
    expect(events).toEqual(['end:stopped'])

    await audio.synthDone()
    await flush()
    expect(audio.log.filter(entry => entry.startsWith('play:'))).toEqual(['play:audio(Première phrase.)'])
    expect(speaker.heard()).toBe('Première phrase.')

    speaker.feed('Encore. ')
    expect(audio.pending()).toEqual([])
  })

  it('reports a synthesis failure once, and plays nothing after it', async () => {
    const audio = fakeAudio()
    const events: string[] = []
    const speaker = new SentenceSpeaker(audio.deps, { onEnd: (reason, error) => events.push(`end:${reason}:${error}`) })

    speaker.feed('Un. Deux. ')
    await audio.synthFails()
    expect(events).toEqual(['end:error:TTS down'])
    await audio.synthDone()
    expect(audio.log.some(entry => entry.startsWith('play:'))).toBe(false)
  })

  it('says nothing for markdown-only text, and ends at once on an empty reply', async () => {
    const audio = fakeAudio()
    const events: string[] = []
    const speaker = new SentenceSpeaker(audio.deps, { onEnd: reason => events.push(reason) })

    speaker.done()
    await flush()
    expect(events).toEqual(['drained'])
    expect(audio.pending()).toEqual([])
  })
})
