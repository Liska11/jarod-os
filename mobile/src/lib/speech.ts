import { speech } from './native.ts'

const PREF_KEY = 'jarod.readAloud'
/** Under Android's 4000-character limit per utterance, cut at a sentence when there is one. */
const MAX_PIECE = 1000
/** A reply longer than this is cut short when read: the screen has the rest. */
const MAX_SPOKEN = 6000

export function readAloudEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === '1'
  } catch {
    return false
  }
}

export function setReadAloud(on: boolean): void {
  try {
    if (on) localStorage.setItem(PREF_KEY, '1')
    else localStorage.removeItem(PREF_KEY)
  } catch {
    // Private storage unavailable: the switch only lasts this session.
  }
}

/**
 * What a Markdown reply sounds like: code blocks are not read (only announced), links read by their
 * text, emphasis, headings, list marks and table bars dropped.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' (bloc de code) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'un lien')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** The text cut into pieces the engine accepts, at the end of a sentence when possible. */
export function speechPieces(text: string, max = MAX_PIECE): string[] {
  const pieces: string[] = []
  let rest = text.length > MAX_SPOKEN ? `${text.slice(0, MAX_SPOKEN)}…` : text
  while (rest.trim()) {
    if (rest.length <= max) {
      pieces.push(rest.trim())
      break
    }
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('\n'))
    const at = cut > max / 3 ? cut + 1 : window.lastIndexOf(' ') > max / 3 ? window.lastIndexOf(' ') : max
    pieces.push(rest.slice(0, at).trim())
    rest = rest.slice(at)
  }
  return pieces.filter(Boolean)
}

/** Reads a reply aloud, replacing whatever was being read. */
export async function readAloud(markdown: string, lang = navigator.language || 'fr-FR'): Promise<void> {
  const pieces = speechPieces(speakableText(markdown))
  for (const [i, text] of pieces.entries()) await speech.speak({ text, lang, flush: i === 0 })
}

export function stopReading(): Promise<void> {
  return speech.stop()
}

export function speechStatus(lang = navigator.language || 'fr-FR'): Promise<{ available: boolean; reason?: string }> {
  return speech.status({ lang })
}
