/**
 * Verdict Q16 (prototype, checkpoint anglais), critère figé le 2026-09-29 AVANT les chiffres décisifs
 * (DECISIONS « B18 — poids reçus ; Q16 — DirectML diagnostiqué, critère figé AVANT les chiffres »).
 * « gagné » = Laya retenu comme candidat pour des décisions en mode FANTÔME, jamais actives. SEULEMENT si :
 *   1. fidélité : graphe dérivé (`allowzero=0`) sur CPU = original sur CPU (écart ≤ 10⁻⁴) ; DirectML vs CPU :
 *      même choix / même côté de 0,5 sur 100 % des états, écart max de probabilité ≤ 10⁻³ ;
 *   2. qualité FR : intent de Laya STRICTEMENT meilleur que bge-m3 zéro-exemple, et `effect` strictement
 *      meilleur que la classe majoritaire ;
 *   3. contexte : un état plus long que `max_len` répond sans erreur, ≤ `max_len` tokens par question.
 * Latence, RSS, EN, accord FR/EN, confiance : relevés SANS seuil. Mesure absente = « incomplet ».
 */

export const PATCH_TOLERANCE = 1e-4;
export const DML_TOLERANCE = 1e-3;

export interface Q16Measures {
  /** Écart max de probabilité, graphe dérivé vs original, sur CPU. */
  patchedCpuMaxDiff: number | null;
  /** DirectML (graphe dérivé) vs CPU. */
  dml: { agree: number; total: number; maxDiff: number } | null;
  frIntent: { laya: number; bge: number; total: number } | null;
  frEffect: { laya: number; majority: number; total: number } | null;
  longContext: { ok: boolean; maxTokens: number; maxLen: number } | null;
}

export interface Q16Verdict {
  verdict: "gagné" | "perdu" | "incomplet";
  reasons: string[];
}

export function q16Verdict(m: Q16Measures): Q16Verdict {
  const reasons: string[] = [];
  const absent = (what: string) => reasons.push(`${what} : mesure absente`);
  if (m.patchedCpuMaxDiff === null) absent("graphe dérivé");
  else if (!(m.patchedCpuMaxDiff <= PATCH_TOLERANCE)) reasons.push(`graphe dérivé : écart CPU ${m.patchedCpuMaxDiff} > ${PATCH_TOLERANCE}`);
  if (!m.dml) absent("DirectML");
  else {
    if (m.dml.total === 0) absent("DirectML");
    else if (m.dml.agree < m.dml.total) reasons.push(`DirectML : ${m.dml.agree}/${m.dml.total} décisions identiques au CPU`);
    if (!(m.dml.maxDiff <= DML_TOLERANCE)) reasons.push(`DirectML : écart max ${m.dml.maxDiff} > ${DML_TOLERANCE}`);
  }
  if (!m.frIntent || m.frIntent.total === 0) absent("intent FR");
  else if (!(m.frIntent.laya > m.frIntent.bge)) reasons.push(`intent FR : Laya ${m.frIntent.laya}/${m.frIntent.total} ≤ bge-m3 ${m.frIntent.bge}/${m.frIntent.total}`);
  if (!m.frEffect || m.frEffect.total === 0) absent("effet FR");
  else if (!(m.frEffect.laya > m.frEffect.majority))
    reasons.push(`effet FR : Laya ${m.frEffect.laya}/${m.frEffect.total} ≤ classe majoritaire ${m.frEffect.majority}/${m.frEffect.total}`);
  if (!m.longContext) absent("contexte long");
  else {
    if (!m.longContext.ok) reasons.push("contexte long : erreur");
    if (m.longContext.maxTokens > m.longContext.maxLen) reasons.push(`contexte long : ${m.longContext.maxTokens} tokens > ${m.longContext.maxLen}`);
  }
  const lost = reasons.some((r) => !r.endsWith("mesure absente"));
  return { verdict: lost ? "perdu" : reasons.length ? "incomplet" : "gagné", reasons };
}
