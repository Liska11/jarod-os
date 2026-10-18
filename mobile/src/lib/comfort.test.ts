import { describe, expect, it } from 'vitest'
import { applyEvent, fromHistory } from './chat-model.ts'
import { checkPick, formatSize, MAX_FILE_BYTES, toBase64 } from './files.ts'
import { speakableText, speechPieces } from './speech.ts'

describe('photos and files from the phone', () => {
  it('accepts images, PDFs and text, by type or by extension', () => {
    expect(checkPick('a.jpg', 'image/jpeg', 10)).toEqual({ mime: 'image/jpeg' })
    expect(checkPick('notes.md', '', 10)).toEqual({ mime: 'text/markdown' })
    expect(checkPick('Relevé.PDF', 'application/octet-stream', 10)).toEqual({ mime: 'application/pdf' })
    expect(checkPick('data.json', 'application/json', 10)).toEqual({ mime: 'application/json' })
  })

  it('refuses other types, empty files, and big non-images (big photos get shrunk)', () => {
    expect(checkPick('setup.apk', 'application/vnd.android.package-archive', 10)).toHaveProperty('error')
    expect(checkPick('page.html', 'text/html', 10)).toHaveProperty('error')
    expect(checkPick('vide.txt', 'text/plain', 0)).toEqual({ error: 'Fichier vide.' })
    expect(checkPick('gros.pdf', 'application/pdf', MAX_FILE_BYTES + 1)).toHaveProperty('error')
    expect(checkPick('photo.jpg', 'image/jpeg', MAX_FILE_BYTES * 3)).toEqual({ mime: 'image/jpeg' })
  })

  it('encodes large files to base64 without overflowing the stack', () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256)
    const back = Uint8Array.from(atob(toBase64(bytes)), ch => ch.charCodeAt(0))
    expect(back).toEqual(bytes)
  })

  it('says sizes the French way', () => {
    expect(formatSize(1536 * 1024)).toBe('1,5 Mo')
    expect(formatSize(340 * 1024)).toBe('340 Ko')
    expect(formatSize(10)).toBe('1 Ko')
  })

  it('shows the files sent with a message, even without text', () => {
    const files = [{ name: 'photo.jpg', mime: 'image/jpeg', size: 2048 }]
    const c = fromHistory('s', [{ id: '1', role: 'user', content: '', attachments: files }])
    expect(c.lines).toEqual([{ id: '1', role: 'user', text: '', files }])
    const live = applyEvent({ sessionId: 's', lines: [], running: false }, {
      type: 'message',
      sessionId: 's',
      message: { id: '2', role: 'user', content: 'et ça ?', attachments: files }
    })
    expect(live.lines[0]).toMatchObject({ text: 'et ça ?', files })
  })
})

describe('reading replies aloud', () => {
  it('reads the words, not the Markdown', () => {
    const md = '## Résultat\n\nVoici **trois** points :\n- un [lien](https://x.fr)\n- `code`\n\n```js\nlet a = 1\n```\nFin.'
    expect(speakableText(md)).toBe('Résultat\nVoici trois points :\nun lien\ncode\n(bloc de code)\nFin.')
    expect(speakableText('Voir https://exemple.fr/page')).toBe('Voir un lien')
  })

  it('cuts long replies at sentence ends, under the engine limit', () => {
    const sentence = 'Une phrase assez longue pour remplir. '
    const pieces = speechPieces(sentence.repeat(60), 200)
    expect(pieces.every(p => p.length <= 200)).toBe(true)
    expect(pieces.every(p => p.endsWith('.'))).toBe(true)
    expect(pieces.join(' ')).toBe(sentence.repeat(60).trim())
    expect(speechPieces('Court.')).toEqual(['Court.'])
    expect(speechPieces('   ')).toEqual([])
  })
})
