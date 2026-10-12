/**
 * Notation PURE des fixtures difficiles (aucun serveur, aucun moteur). Règles figées par l'utilisateur le 2026-10-02 :
 *  - abstention correcte = `intent`, `effect` ET `risk` à `null` tous les trois (un ou deux sans le reste ne valide pas ;
 *    « aucun effet » ou « risque 0 » sur une demande indécidable est une affirmation, pas une abstention) ;
 *  - cas ambigu : deux lectures recevables (`alt`), jugées EN ENTIER (intent et effet d'une même lecture) ;
 *  - réponse inutilisable ou absente = fausse, jamais devinée ;
 *  - le score n'est ni une réussite ni un échec : il oriente la suite (`nextStep`).
 * Hors abstention, le risque (`risk`) est RAPPORTÉ à part, hors du score, tant que l'utilisateur ne l'a pas validé.
 */
import type { HardFixture, Kind, Reading } from "./q16-hard-fixtures.js";

export interface HardAnswer {
  intent: Reading["intent"];
  effect: Reading["effect"];
  /** `null` = abstention sur le risque (exigée avec `intent: null`) ; hors abstention, informatif seulement. */
  risk: Reading["risk"];
}

export const readingsOf = (f: HardFixture): Reading[] => [{ intent: f.intent, effect: f.effect, risk: f.risk }, ...(f.alt ? [f.alt] : [])];

/** Une abstention valide abstient les TROIS questions ; un `null` sur une ou deux seulement n'en est pas une. */
export const isAbstention = (a: HardAnswer): boolean => a.intent === null && a.effect === null && a.risk === null;

/**
 * Juste = (intent, effet) égale une lecture recevable en entier. Si cette lecture est l'abstention, le risque doit être
 * `null` lui aussi ; sinon le risque n'entre pas dans le jugement.
 */
export const isCorrect = (f: HardFixture, a: HardAnswer | null): boolean =>
  a !== null && readingsOf(f).some((r) => r.intent === a.intent && r.effect === a.effect && (r.intent !== null || a.risk === null));

export interface HardScore {
  n: number;
  correct: number;
  /** Repères séparés, comparables aux 60 faciles (intent /N et effet /N). */
  intentOk: number;
  effectOk: number;
  /** Informatif : risque égal à celui d'une lecture recevable. */
  riskOk: number;
  unusable: number;
  /** Abstentions rendues (valides ou non), et celles attendues. */
  abstained: number;
  /** `intent: null` avec un autre champ renseigné : sortie incohérente rendue telle quelle, jugée fausse, jamais normalisée. */
  partialAbstentions: number;
  abstentionExpected: number;
  abstentionCorrect: number;
  byKind: Record<string, { n: number; correct: number }>;
}

export function scoreHard(fixtures: readonly HardFixture[], answers: readonly (HardAnswer | null)[]): HardScore {
  if (answers.length !== fixtures.length) throw new Error(`réponses ${answers.length} ≠ fixtures ${fixtures.length}`);
  const s: HardScore = {
    n: fixtures.length, correct: 0, intentOk: 0, effectOk: 0, riskOk: 0, unusable: 0,
    abstained: 0, partialAbstentions: 0, abstentionExpected: 0, abstentionCorrect: 0, byKind: {},
  };
  fixtures.forEach((f, i) => {
    const a = answers[i] ?? null;
    const ok = isCorrect(f, a);
    const k = (s.byKind[f.kind satisfies Kind] ??= { n: 0, correct: 0 });
    k.n++;
    if (ok) {
      s.correct++;
      k.correct++;
    }
    const rs = readingsOf(f);
    if (f.intent === null) s.abstentionExpected++;
    if (a === null) {
      s.unusable++;
      return;
    }
    if (isAbstention(a)) s.abstained++;
    else if (a.intent === null) s.partialAbstentions++;
    if (f.intent === null && ok) s.abstentionCorrect++;
    if (rs.some((r) => r.intent === a.intent)) s.intentOk++;
    if (rs.some((r) => r.effect === a.effect)) s.effectOk++;
    if (rs.some((r) => r.risk === a.risk)) s.riskOk++;
  });
  return s;
}

export type NextStep = "action" | "investigation" | "rien";

/**
 * < 40 % → action ; 40 % à 70 % inclus → investigation ; > 70 % → rien (décision utilisateur 2026-10-02). Comparaison en
 * entiers (pas de flottant aux bornes). Ce n'est pas un verdict de réussite : un score bas n'est pas un échec.
 */
export function nextStep(correct: number, n: number): NextStep {
  if (!Number.isInteger(correct) || !Number.isInteger(n) || n <= 0 || correct < 0 || correct > n) throw new Error("score invalide");
  if (correct * 100 < 40 * n) return "action";
  if (correct * 100 <= 70 * n) return "investigation";
  return "rien";
}
