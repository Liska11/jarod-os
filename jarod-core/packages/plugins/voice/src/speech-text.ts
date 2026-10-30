// Ce que la voix doit dire (30/10) : le texte AFFICHÉ reste tel quel ; seul le texte envoyé à la synthèse est nettoyé (markdown, émojis, flèches,
// adresses, blocs de code) puis passé au dictionnaire de prononciation. Appliqué au plus bas niveau (SpeechService), donc pour tout appelant :
// `/api/audio/speak`, l'outil de lecture, la fenêtre.

export interface Pronunciation {
  /** Ce qui est écrit (insensible à la casse, mot entier). */
  written: string;
  /** Ce que la voix doit lire : une orthographe phonétique pour une voix française. */
  spoken: string;
}

/**
 * Le dictionnaire par défaut est VIDE : mesuré le 30/10, Hortense lit « Demba-san » assez juste pour qu'un modèle d'écoute le retranscrive
 * « Dembassan », alors que les orthographes phonétiques essayées (« Dèmba sanne », « Dèmba sane », « Dème ba sanne ») sont retranscrites plus
 * mal (« M Bassan », « M Bassene »). Une entrée s'ajoute ici (ou dans `SpeechDeps.pronunciations`) si l'oreille de l'utilisateur entend un défaut.
 */
export const DEFAULT_PRONUNCIATIONS: readonly Pronunciation[] = [];

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;
// Flèches, pictogrammes et symboles que la voix épelle ou ignore : → ← ↑ ↓ ⇒ ➜ ✓ ✔ ✗ ✘ • ▪ ■ ● ◆ ★ ☆
const SYMBOLS = /[←-⇿➔-➿⟰-⟿⤀-⥿•‣■-◿★☆✓✔✗✘]/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Retire de ce que la voix lirait tout ce qui n'est pas de la parole : markdown, code, adresses, émojis, flèches. */
export function cleanForSpeech(text: string): string {
  return String(text ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:https?:\/\/|www\.)\S+/gi, "un lien")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/^-{3,}\s*$/gm, " ")
    .replace(EMOJI, "")
    .replace(SYMBOLS, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Remplace les mots écrits par leur prononciation (plus longs d'abord : « Demba-san » avant « Demba »). */
export function applyPronunciations(text: string, dictionary: readonly Pronunciation[] = DEFAULT_PRONUNCIATIONS): string {
  let out = text;
  for (const { written, spoken } of [...dictionary].sort((a, b) => b.written.length - a.written.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(written)}(?![\\p{L}\\p{N}])`, "giu"), () => spoken);
  }
  return out;
}

/** Le texte tel que la voix le lira. */
export function spokenText(text: string, dictionary: readonly Pronunciation[] = DEFAULT_PRONUNCIATIONS): string {
  return applyPronunciations(cleanForSpeech(text), dictionary);
}
