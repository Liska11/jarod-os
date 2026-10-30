import { describe, expect, it } from 'vitest'
import { chunkForCommentary, COMMENTARY_MAX_CHARS, firstSentences, isNoiseTranscript, isStopPhrase, sanitizeForSpeech, SentenceChunker } from './speech-text.ts'

describe('sanitizeForSpeech', () => {
  it('strips markdown, code and links', () => {
    const text = '## Result\n\nI found **three** files:\n- `a.txt`\n- [docs](https://example.com/x)\n\n```js\nconsole.log(1)\n```\nDone.'
    const spoken = sanitizeForSpeech(text)
    expect(spoken).not.toContain('#')
    expect(spoken).not.toContain('**')
    expect(spoken).not.toContain('console.log')
    expect(spoken).not.toContain('https://')
    expect(spoken).toContain('three files')
    expect(spoken).toContain('docs')
    expect(spoken).toContain('Done.')
  })

  it('drops thinking blocks', () => {
    expect(sanitizeForSpeech('<think>secret</think>Hello there.')).toBe('Hello there.')
  })
})

describe('SentenceChunker', () => {
  it('yields sentences as they close and keeps the tail', () => {
    const chunker = new SentenceChunker()
    expect(chunker.feed('Hello there. How are')).toEqual(['Hello there.'])
    expect(chunker.pending).toBe('How are')
    expect(chunker.feed(' you today? Fine')).toEqual(['How are you today?'])
    expect(chunker.flush()).toEqual(['Fine'])
    expect(chunker.pending).toBe('')
  })

  it('does not cut on a period without following whitespace (decimals, versions)', () => {
    const chunker = new SentenceChunker()
    expect(chunker.feed('Version 0.21.3 is out')).toEqual([])
    expect(chunker.feed('. ')).toEqual(['Version 0.21.3 is out.'])
  })

  it('treats a blank line as a boundary', () => {
    const chunker = new SentenceChunker()
    expect(chunker.feed('First item\n\nSecond')).toEqual(['First item'])
    expect(chunker.flush()).toEqual(['Second'])
  })
})

describe('chunkForCommentary', () => {
  it('returns one chunk for short text', () => {
    expect(chunkForCommentary('Short **answer**.')).toEqual(['Short answer.'])
  })

  it('splits long text at sentence boundaries under the cap', () => {
    const sentence = 'This is a fairly long sentence that keeps going for a while. '
    const chunks = chunkForCommentary(sentence.repeat(60))
    expect(chunks.length).toBeGreaterThan(1)

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(COMMENTARY_MAX_CHARS)
      expect(chunk.endsWith('.')).toBe(true)
    }
  })

  it('hard-splits a single oversized sentence', () => {
    const chunks = chunkForCommentary('x'.repeat(COMMENTARY_MAX_CHARS * 2 + 10))
    expect(chunks.length).toBe(3)
  })

  it('returns nothing for empty input', () => {
    expect(chunkForCommentary('   ')).toEqual([])
  })
})

describe('isStopPhrase', () => {
  it('matches whole-utterance stop commands regardless of case and punctuation', () => {
    expect(isStopPhrase('Stop.')).toBe(true)
    expect(isStopPhrase("That's all, Hermes")).toBe(true)
    expect(isStopPhrase('okay stop')).toBe(true)
  })

  it('does not match stop words inside a request', () => {
    expect(isStopPhrase('stop the dev server on port 3000')).toBe(false)
    expect(isStopPhrase('')).toBe(false)
  })
})

describe('isNoiseTranscript', () => {
  it('flags whisper hallucinations on silence', () => {
    expect(isNoiseTranscript('Thank you.')).toBe(true)
    expect(isNoiseTranscript('you')).toBe(true)
    expect(isNoiseTranscript('Open Safari')).toBe(false)
  })
})

describe('firstSentences', () => {
  it('keeps the first two sentences of a long reply, whatever its form', () => {
    expect(firstSentences('Un. Deux. Trois. Quatre.')).toBe('Un. Deux.')
    expect(firstSentences('Un seul.')).toBe('Un seul.')
    expect(firstSentences('Salut ! Ça va ? Très bien.')).toBe('Salut ! Ça va ?')
    expect(firstSentences('')).toBe('')
  })
})
