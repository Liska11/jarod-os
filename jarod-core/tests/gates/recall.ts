/**
 * Rappel de mots normalisé (gate P3 dictée ; banc TTS Piper) : extrait tel quel de
 * `gates/p3-voice.test.ts` pour être partagé — même normalisation, même métrique.
 */
/** Nombres écrits en lettres → chiffres (0-20), comme le fait toute normalisation de WER. */
const NUMBERS = ["zero", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf", "vingt"];
export const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // « 8h », « 8 h » : l'heure écrite en abrégé est la même que « huit heures ».
    .replace(/\b(\d+)\s*h\b/g, "$1 heures")
    .replace(/[^a-z0-9 -]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const n = NUMBERS.indexOf(w);
      return n >= 0 ? String(n) : w.replace(/-/g, "");
    })
    .filter(Boolean);

/** Rappel de mots : proportion des mots de la phrase retrouvés dans la transcription. */
export function recall(expected: string, got: string): number {
  const g = new Set(words(got));
  const e = words(expected);
  return e.filter((w) => g.has(w)).length / e.length;
}

