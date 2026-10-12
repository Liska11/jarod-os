/**
 * SPECS-P5-CAUSAL.md §5 et §9 — verdict de la mesure de la mémoire causale. Fonction PURE (arithmétique entière : aucune erreur d'arrondi à la frontière).
 * Barres validées par l'utilisateur (2026-10-02) AVANT toute mesure : rappel@3 supérieur à la référence d'au moins 10 points absolus ; précision hors cibles
 * d'au moins 80 % ; DEUX RÉGIMES du 150 (confirmé par l'utilisateur, 2026-10-02) : au moins 150 cibles → verdict FINAL ; en dessous → résultat RENDU,
 * marqué « faible effectif », réexamen avec l'utilisateur avant toute action (jamais un verdict automatique, jamais un chiffre masqué).
 */
export const BARS = { minTargets: 150, minGainPoints: 10, minPrecisionPercent: 80 } as const;

export interface CausalMeasure {
  /** Échecs de l'évaluation dont la signature a déjà été vue dans l'apprentissage (recensement exhaustif). */
  targets: number;
  /** Cibles pour lesquelles la référence (plein texte des messages) a rendu un échec de même signature dans ses 3 premiers. */
  baselineHits: number;
  /** Idem pour la voie testée (plein texte des épisodes). */
  systemHits: number;
  /** Actions réussies de l'évaluation, sans échec antérieur de même signature. */
  offTargets: number;
  /** Parmi elles, celles où la voie testée propose pourtant un échec dans ses 3 premiers (fausse alerte). */
  falseAlarms: number;
}

export type CausalVerdictKind = "victoire" | "defaite" | "faible_effectif" | "incomplet";
export interface CausalVerdict {
  verdict: CausalVerdictKind;
  recallBaselinePercent: number | null;
  recallSystemPercent: number | null;
  gainPoints: number | null;
  precisionPercent: number | null;
  /** Conditions manquées, une phrase chacune (listées aussi en faible effectif, pour l'examen). */
  missed: string[];
  /** Verdict final (≥ 150 cibles) ? Faux = résultat rendu pour réexamen, aucune action. */
  final: boolean;
  notes: string[];
}

export function causalVerdict(m: CausalMeasure): CausalVerdict {
  const empty = { recallBaselinePercent: null, recallSystemPercent: null, gainPoints: null, precisionPercent: null };
  const coherent =
    [m.targets, m.baselineHits, m.systemHits, m.offTargets, m.falseAlarms].every((n) => Number.isInteger(n) && n >= 0) &&
    m.targets > 0 &&
    m.offTargets > 0 &&
    m.baselineHits <= m.targets &&
    m.systemHits <= m.targets &&
    m.falseAlarms <= m.offTargets;
  if (!coherent) return { verdict: "incomplet", ...empty, missed: ["mesure absente ou incohérente"], final: false, notes: [] };

  const pct = (a: number, b: number) => Math.round((a / b) * 10000) / 100;
  const base = {
    recallBaselinePercent: pct(m.baselineHits, m.targets),
    recallSystemPercent: pct(m.systemHits, m.targets),
    gainPoints: pct(m.systemHits - m.baselineHits, m.targets),
    precisionPercent: pct(m.offTargets - m.falseAlarms, m.offTargets),
  };
  const missed: string[] = [];
  // Entiers : 100 × (système − référence) ≥ 10 × cibles ; 100 × (hors cibles − fausses alertes) ≥ 80 × hors cibles.
  if (100 * (m.systemHits - m.baselineHits) < BARS.minGainPoints * m.targets)
    missed.push(`gain de rappel@3 : ${base.gainPoints} points < ${BARS.minGainPoints}`);
  if (100 * (m.offTargets - m.falseAlarms) < BARS.minPrecisionPercent * m.offTargets)
    missed.push(`précision hors cibles : ${base.precisionPercent} % < ${BARS.minPrecisionPercent} %`);
  if (m.targets < BARS.minTargets)
    return {
      verdict: "faible_effectif",
      ...base,
      missed,
      final: false,
      notes: [`faible effectif : ${m.targets} cibles < ${BARS.minTargets} — résultat rendu, PAS de verdict final ; réexamen avec l'utilisateur avant toute action`],
    };
  return { verdict: missed.length ? "defaite" : "victoire", ...base, missed, final: true, notes: [] };
}
