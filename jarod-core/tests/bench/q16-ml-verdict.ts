/**
 * Verdict Q16 multilingue (checkpoint `convaiinnovations/laya-multilingual`, accord B19), barre FIGÉE le 2026-09-29 dans
 * DECISIONS (« Décisions utilisateur (suite Q16 ; pack master plan) », (2)) AVANT tout octet téléchargé et avant tout run ;
 * ce fichier ne fait que la CODER, telle quelle. Sur les 60 fixtures FR de `q16-fixtures.ts` :
 *   1. intent FR ≥ 45/60 ;
 *   2. écart au baseline bge-m3 zéro-exemple ≥ +5 points — lu en REQUÊTES sur 60 (l'unité de l'intent) ; avec bge-m3 à 34/60
 *      (bench du 2026-09-29) la ligne 1 (≥ 45) implique déjà +11 requêtes (+18 points de pourcentage) : la lecture en points de
 *      pourcentage (≥ +5 pts = ≥ +3 requêtes) donne le même verdict — l'ambiguïté est sans effet ;
 *   3. confiance médiane FR ≥ 0,30 — mêmes définition et médiane que le prototype anglais (0,15) : 1 − H(p)/ln(k) sur les
 *      probabilités de la question `intent`, rang le plus proche (médiane basse des 60) ;
 *   4. rappels (`reminder`) ≥ 8/12.
 * Latence (CPU, DirectML) : relevée APRÈS identification de l'adaptateur DirectML, SANS seuil — elle ne fait pas partie du verdict.
 * Une seule ligne sous la barre → « clôture » (Q16 fermé, tout l'appris consigné) ; toutes au-dessus → « fantôme »
 * (mode fantôme sur `ecosystem.decisionEngine`, jamais actif). Une mesure absente → « incomplet ».
 */

export const BAR = { intentFr: 45, gapVsBge: 5, medianConfidenceFr: 0.3, reminder: 8 } as const;

export interface Q16MlMeasures {
  frIntent: { laya: number; bge: number; total: number } | null;
  /** Médiane basse (rang le plus proche) de 1 − H(p)/ln(k) sur les 60 requêtes FR. */
  frMedianConfidence: number | null;
  frReminder: { hits: number; total: number } | null;
}

export interface Q16MlVerdict {
  verdict: "fantôme" | "clôture" | "incomplet";
  /** Une ligne par barre : « ok » ou la raison ; la mesure absente est signalée sans compter comme échec. */
  lines: { bar: string; ok: boolean | null; detail: string }[];
}

export function q16MlVerdict(m: Q16MlMeasures): Q16MlVerdict {
  const lines: Q16MlVerdict["lines"] = [];
  const line = (bar: string, ok: boolean | null, detail: string) => lines.push({ bar, ok, detail });
  if (!m.frIntent || m.frIntent.total === 0) {
    line(`intent FR ≥ ${BAR.intentFr}/60`, null, "mesure absente");
    line(`écart à bge-m3 ≥ +${BAR.gapVsBge}`, null, "mesure absente");
  } else {
    const { laya, bge, total } = m.frIntent;
    line(`intent FR ≥ ${BAR.intentFr}/60`, laya >= BAR.intentFr, `${laya}/${total}`);
    line(`écart à bge-m3 ≥ +${BAR.gapVsBge}`, laya - bge >= BAR.gapVsBge, `${laya} − ${bge} = ${laya - bge}`);
  }
  if (m.frMedianConfidence === null) line(`confiance médiane FR ≥ ${BAR.medianConfidenceFr}`, null, "mesure absente");
  else line(`confiance médiane FR ≥ ${BAR.medianConfidenceFr}`, m.frMedianConfidence >= BAR.medianConfidenceFr, String(m.frMedianConfidence));
  if (!m.frReminder || m.frReminder.total === 0) line(`rappels ≥ ${BAR.reminder}/12`, null, "mesure absente");
  else line(`rappels ≥ ${BAR.reminder}/12`, m.frReminder.hits >= BAR.reminder, `${m.frReminder.hits}/${m.frReminder.total}`);
  const verdict = lines.some((l) => l.ok === false) ? "clôture" : lines.some((l) => l.ok === null) ? "incomplet" : "fantôme";
  return { verdict, lines };
}
