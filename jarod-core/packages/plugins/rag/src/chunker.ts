/**
 * Découpage en chunks (PLAN §10 phase 2, lot A). Fonctions PURES et déterministes : même texte, même manifeste,
 * mêmes réglages ⇒ mêmes chunks, aux mêmes décalages — pas d'horloge, pas d'aléa, pas d'entrée-sortie.
 *
 * - `chunkText` / `chunkTextSpans` : le découpage d'origine de plugin-rag (par caractères), inchangé. C'est celui
 *   des documents du parseur `builtin` : les rappels mesurés en dépendent (instantané `ingest-golden`).
 * - `chunkDocument` : le découpage d'un document STRUCTURÉ (manifeste à sections, ex. Docling au lot B) — il
 *   respecte les frontières de section et rend, pour chaque chunk, sa section.
 */
import type { DocumentManifest } from "@jarod/contracts";

/**
 * Splits text into overlapping chunks, preferring to cut at the end of a line and otherwise at a
 * space, so a chunk rarely starts or ends mid-word. A hard cut is the fallback for one long line.
 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  return chunkTextSpans(text, size, overlap).map((c) => c.text);
}

/** Un chunk et sa place dans le texte : `text.slice(start, end) === chunk.text`. */
export interface TextChunk {
  text: string;
  start: number;
  end: number;
}

/** `chunkText` avec les décalages (unités UTF-16) : mêmes coupes, mêmes chunks, dans le même ordre. */
export function chunkTextSpans(text: string, size: number, overlap: number): TextChunk[] {
  const limit = Math.max(1, Math.floor(size));
  const step = Math.max(1, limit - Math.max(0, Math.floor(overlap)));
  const out: TextChunk[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + limit);
    if (end < text.length) {
      const window = text.slice(i, end);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      const cut = nl >= Math.floor(limit / 2) ? nl : sp >= Math.floor(limit / 2) ? sp : -1;
      if (cut > 0) end = i + cut + 1;
    }
    const piece = text.slice(i, end);
    if (piece.trim()) out.push({ text: piece, start: i, end });
    if (end >= text.length) break;
    i = Math.max(i + 1, end - (limit - step));
  }
  return out;
}

/** Section la plus profonde qui contient `offset` (les sections sont rangées par début, imbriquées), ou null. */
export function sectionAt(sections: DocumentManifest["sections"], offset: number): string | null {
  let title: string | null = null;
  for (const s of sections) {
    if (s.start > offset) break;
    if (offset < s.end) title = s.title;
  }
  return title;
}

/**
 * Un chunk d'un document structuré. `page` : la page d'un chunk n'est connue que si le manifeste donne les pages
 * par plage de texte, ce qu'il ne fait pas encore (il ne date que les repères) — `null` = inconnue, jamais devinée.
 */
export interface DocumentChunk extends TextChunk {
  page: number | null;
  section: string | null;
}

/**
 * Découpe un document structuré. Règles, toutes déterministes :
 * 1. Le texte est coupé aux débuts de section (tous niveaux) : aucun chunk ne franchit une frontière gardée.
 * 2. Une frontière est abandonnée quand le segment qui la précède fait moins d'un quart de la taille visée : un
 *    titre seul, ou une section de deux lignes, ne devient pas un chunk à lui tout seul, il rejoint la suite.
 * 3. Dans chaque segment, le découpage est celui d'origine (`chunkTextSpans`) : mêmes coupes en fin de ligne ou à
 *    l'espace, même recouvrement — jamais au-delà d'une frontière.
 * 4. La section d'un chunk est la plus profonde qui contient son début.
 * Sans section, le résultat est exactement celui de `chunkTextSpans`.
 */
export function chunkDocument(doc: { manifest: DocumentManifest; text: string }, size: number, overlap: number): DocumentChunk[] {
  const { manifest, text } = doc;
  const minSegment = Math.max(1, Math.floor(Math.max(1, Math.floor(size)) / 4));
  const starts = [...new Set(manifest.sections.map((s) => s.start))].filter((o) => o > 0 && o < text.length).sort((a, b) => a - b);
  const bounds = [0];
  for (const o of starts) if (o - bounds[bounds.length - 1]! >= minSegment) bounds.push(o);
  bounds.push(text.length);

  const sections = [...manifest.sections].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: DocumentChunk[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const from = bounds[k]!;
    for (const c of chunkTextSpans(text.slice(from, bounds[k + 1]!), size, overlap)) {
      const start = from + c.start;
      out.push({ text: c.text, start, end: from + c.end, page: null, section: sectionAt(sections, start) });
    }
  }
  return out;
}
