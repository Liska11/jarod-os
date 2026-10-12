/**
 * Verdict C0-a, critère FIGÉ le 2026-09-29 AVANT toute mesure (DECISIONS « Ingestion, C0 — critères et barres figés »).
 * Le lexical (FTS5/BM25 fusionné au dense par RRF) est jugé UTILE seulement si, aux tailles 10⁴ ET 10⁵ :
 *   (a) l'hybride ≥ le dense en succès @3 sur A (24 requêtes P2) ET sur B (176 extraits) ;
 *   (b) rappel@10 de l'hybride ≥ celui du dense + 5 points sur D (200 requêtes mots-clés) ;
 * et, à 10⁵ seulement :
 *   (c) p95 du volet FTS5 seul ≤ 10 ms (médiane des passages en processus neufs).
 * Une mesure absente = « incomplet », jamais une victoire. Le reste (rappels des trois méthodes, taille de l'index,
 * temps de construction) est relevé sans seuil.
 */

export const C0_SIZES = [10_000, 100_000] as const;
export const GAIN_POINTS = 5;
export const FTS_P95_MS = 10;

/** Nombres de requêtes réussies (pas des ratios). */
export interface Recall {
  at1: number;
  at3: number;
  at10: number;
}
export interface SetResult {
  n: number;
  dense: Recall;
  fts: Recall;
  hybrid: Recall;
}
export interface C0Run {
  size: number;
  A: SetResult;
  B: SetResult;
  D: SetResult;
  /** p95 du volet FTS5 seul, un par passage (processus neuf). */
  ftsP95Ms: number[];
}

export interface C0Verdict {
  verdict: "utile" | "non utile" | "incomplet";
  reasons: string[];
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function c0Verdict(runs: readonly C0Run[]): C0Verdict {
  const reasons: string[] = [];
  let missing = false;
  for (const size of C0_SIZES) {
    const r = runs.find((x) => x.size === size);
    if (!r || (size === 100_000 && r.ftsP95Ms.length === 0)) {
      missing = true;
      reasons.push(`${size} : mesure absente`);
      continue;
    }
    for (const set of ["A", "B"] as const) {
      const s = r[set];
      if (s.hybrid.at3 < s.dense.at3) reasons.push(`${size} : régression sur ${set} — hybride @3 ${s.hybrid.at3} < dense @3 ${s.dense.at3} (sur ${s.n})`);
    }
    const d = r.D;
    if ((d.hybrid.at10 - d.dense.at10) * 100 < GAIN_POINTS * d.n)
      reasons.push(
        `${size} : gain sur D insuffisant — rappel@10 hybride ${((d.hybrid.at10 / d.n) * 100).toFixed(1)} % contre dense ${((d.dense.at10 / d.n) * 100).toFixed(1)} % (écart < ${GAIN_POINTS} points)`,
      );
    if (size === 100_000) {
      const p95 = median(r.ftsP95Ms);
      if (!(p95 <= FTS_P95_MS)) reasons.push(`${size} : p95 du volet FTS5 ${p95.toFixed(2)} ms > ${FTS_P95_MS} ms`);
    }
  }
  if (missing) return { verdict: "incomplet", reasons };
  return { verdict: reasons.length ? "non utile" : "utile", reasons };
}
