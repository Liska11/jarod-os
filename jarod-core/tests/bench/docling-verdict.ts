/**
 * Verdict de la gate B (fidélité Docling), critères et barres FIGÉS le 2026-09-30 AVANT toute mesure
 * (DECISIONS « Ingestion, gate ⑦ … critères et barres FIGÉS »). Pur : aucune E/S.
 *
 * Référence = extraction AUTOMATIQUE indépendante (pdfium ; XML brut des archives Office), pas une vérité humaine :
 * le verdict est « sur la référence automatique ». Une mesure absente = « incomplet », jamais une victoire.
 */

/** Barres figées. */
export const MIN_RECALL = 0.95;
export const FLOOR_RECALL = 0.8;
export const MAX_EXCESS = 0.1;

/**
 * Métrique v2 (DECISIONS 2026-09-30, option B de l'utilisateur) : le SORTIE est débarrassée de deux artefacts du rendu
 * Markdown qui ne sont pas du contenu du document — le marqueur `<!-- image -->` et la cible d'un lien `[texte](cible)`
 * (le texte du lien est gardé). Les deux autres artefacts connus (cellules fusionnées répétées, dates rendues) sont
 * traités du côté de la RÉFÉRENCE (docling-reference.py), car ils viennent du document.
 */
export function normalizeOutput(text: string): string {
  return text.replace(/<!--\s*image\s*-->/gi, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/** Jetons : suites de lettres/chiffres après NFKC, minuscules, sans accents. */
export function tokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function counts(list: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/**
 * rappel = Σ min(n_réf, n_sortie) / Σ n_réf (multi-ensemble, insensible à l'ordre) ;
 * excès = jetons de sortie absents de la référence / jetons de sortie (multi-ensemble aussi).
 * Référence vide ⇒ rappel 1 (rien à perdre) ; sortie vide ⇒ excès 0.
 */
export function compare(reference: string, output: string): { recall: number; excess: number; refTokens: number; outTokens: number } {
  const r = counts(tokens(reference));
  const o = counts(tokens(output));
  let refTotal = 0;
  let outTotal = 0;
  let common = 0;
  for (const [t, n] of r) {
    refTotal += n;
    common += Math.min(n, o.get(t) ?? 0);
  }
  for (const n of o.values()) outTotal += n;
  return {
    recall: refTotal === 0 ? 1 : common / refTotal,
    excess: outTotal === 0 ? 0 : (outTotal - common) / outTotal,
    refTokens: refTotal,
    outTokens: outTotal,
  };
}

export type Format = "pdf" | "docx" | "pptx" | "xlsx";

/** Ce qu'on sait de la référence, pour les barres de structure. */
export interface RefStructure {
  pages?: number; // pdf
  tables?: number; // docx : w:tbl
  headings?: number; // docx : styles de titre
  cells?: number; // xlsx : cellules non vides
}

/** Un document mesuré (taille ≤ borne, lu par le worker). */
export interface DocResult {
  id: string;
  format: Format;
  recall: number;
  excess: number;
  /** SHA-256 de {manifeste, texte}, passages 1 et 2 (processus neufs). */
  hashes: [string | null, string | null];
  manifestPages: number;
  manifestTables: number;
  manifestSections: number;
  ref: RefStructure;
  /** Échec de PROCESSUS (mort, délai, réponse invalide) — pas une erreur de document. */
  processFailure: boolean;
}

export interface Robustness {
  /** Processus du venv encore vivants après l'arrêt. */
  orphans: number;
  /** Les cas corrompu / 0 octet / trop gros ont donné une erreur nette sans exception non rattrapée. */
  cleanRefusals: boolean;
}

export type BarId = "recall" | "excess" | "determinism" | "pages" | "structure" | "robustness";

export interface Verdict {
  verdict: "verte" | "rouge" | "incomplète";
  bars: Record<BarId, { ok: boolean | null; detail: string }>;
}

export function structureGaps(d: DocResult): string[] {
  const gaps: string[] = [];
  if (d.format === "docx" && (d.ref.tables ?? 0) >= 1 && d.manifestTables < 1) gaps.push("tables");
  if (d.format === "docx" && (d.ref.headings ?? 0) >= 1 && d.manifestSections < 1) gaps.push("sections");
  if (d.format === "xlsx" && (d.ref.cells ?? 0) >= 1 && d.manifestTables < 1) gaps.push("tables");
  return gaps;
}

export function galleryVerdict(docs: readonly DocResult[], robustness: Robustness | null, expected: number): Verdict {
  const complete = docs.length === expected && expected > 0 && robustness !== null;
  const names = (xs: DocResult[]) => (xs.length ? xs.map((d) => d.id).join(", ") : "aucun");

  const lowRecall = docs.filter((d) => d.recall < MIN_RECALL);
  const floor = docs.filter((d) => d.recall < FLOOR_RECALL);
  const highExcess = docs.filter((d) => d.excess > MAX_EXCESS);
  const nonDeterministic = docs.filter((d) => d.hashes[0] === null || d.hashes[1] === null || d.hashes[0] !== d.hashes[1]);
  const pdfs = docs.filter((d) => d.format === "pdf");
  const badPages = pdfs.filter((d) => d.ref.pages === undefined || d.manifestPages !== d.ref.pages);
  const gaps = docs.filter((d) => structureGaps(d).length > 0);
  const failures = docs.filter((d) => d.processFailure);

  const bars: Verdict["bars"] = {
    recall: { ok: docs.length === 0 ? null : lowRecall.length === 0 && floor.length === 0, detail: `< 95 % : ${names(lowRecall)} ; < 80 % : ${names(floor)}` },
    excess: { ok: docs.length === 0 ? null : highExcess.length === 0, detail: `> 10 % : ${names(highExcess)}` },
    determinism: { ok: docs.length === 0 ? null : nonDeterministic.length === 0, detail: `empreintes différentes ou absentes : ${names(nonDeterministic)}` },
    pages: { ok: badPages.length === 0, detail: pdfs.length === 0 ? "sans objet (aucun PDF)" : `pages du manifeste ≠ pdfium : ${names(badPages)}` },
    structure: { ok: docs.length === 0 ? null : gaps.length === 0, detail: `structure perdue : ${gaps.map((d) => `${d.id}(${structureGaps(d).join("+")})`).join(", ") || "aucun"}` },
    robustness: {
      ok: robustness === null ? null : failures.length === 0 && robustness.orphans === 0 && robustness.cleanRefusals,
      detail: `échecs de processus : ${names(failures)} ; orphelins : ${robustness?.orphans ?? "?"} ; refus nets : ${robustness?.cleanRefusals ?? "?"}`,
    },
  };
  const all = Object.values(bars);
  if (all.some((b) => b.ok === false)) return { verdict: "rouge", bars };
  if (!complete || all.some((b) => b.ok === null)) return { verdict: "incomplète", bars };
  return { verdict: "verte", bars };
}
