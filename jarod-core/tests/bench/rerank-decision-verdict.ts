/**
 * Passe de décision d'activation du reranker (SPECS-P5-RERANKER.md §10) : fonctions PURES. Les seuils sont ceux APPROUVÉS par l'utilisateur le
 * 2026-10-02 (« Barres A à E approuvées avec les seuils ◆ »). Rien ici n'active quoi que ce soit : le verdict le plus favorable est
 * « utile_en_usage », et le passage de `shadow` à `active` reste une décision de l'utilisateur.
 */

export const BARS = {
  /** (A) S1 : reranké @1 ≥ dense @1 + 3. */
  aGainAt1: 3,
  /** (B) S2 : reranké @1 ≥ dense @1 + 2. */
  bGainAt1: 2,
  /** (C) pertes tolérées sur S1. */
  cMaxLossesS1: 1,
  /** (D) lignes minimales du rapport fantôme postérieures au nettoyage, taux `ok`, p95. */
  dMinLines: 30,
  dMinOkRate: 0.95,
  dMaxP95Ms: 4_000,
} as const;

export interface Metrics {
  n: number;
  at1: number;
  at3: number;
  mrr: number;
}

/** Rangs du premier passage-réponse (null = absent des résultats). */
export function setMetrics(ranks: readonly (number | null)[]): Metrics {
  const n = ranks.length;
  if (n === 0) return { n: 0, at1: 0, at3: 0, mrr: 0 };
  const at = (k: number) => ranks.filter((r) => r !== null && r <= k).length;
  const mrr = ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / n;
  return { n, at1: at(1), at3: at(3), mrr: Number(mrr.toFixed(4)) };
}

export interface GainsLosses {
  gains: number;
  losses: number;
}

/** Gagnée : dense ≠ 1 et reranké = 1. Perdue : dense = 1 et reranké ≠ 1. */
export function gainsLosses(base: readonly (number | null)[], rr: readonly (number | null)[]): GainsLosses {
  if (base.length !== rr.length) throw new Error("listes de rangs de longueurs différentes");
  let gains = 0;
  let losses = 0;
  for (let i = 0; i < base.length; i++) {
    const b = base[i] === 1;
    const r = rr[i] === 1;
    if (!b && r) gains++;
    if (b && !r) losses++;
  }
  return { gains, losses };
}

export interface ShadowLine {
  t: number;
  outcome: string;
  ms: number;
}
export interface RealUse {
  n: number;
  ok: number;
  okRate: number;
  errors: number;
  p95Ms: number;
}

/** Lignes du rapport fantôme STRICTEMENT postérieures à la coupe (`t` en ms). */
export function realUseStats(lines: readonly ShadowLine[], cutMs: number): RealUse {
  const post = lines.filter((l) => l.t > cutMs);
  if (post.length === 0) return { n: 0, ok: 0, okRate: 0, errors: 0, p95Ms: 0 };
  const ok = post.filter((l) => l.outcome === "ok").length;
  const ms = post.map((l) => l.ms).sort((a, b) => a - b);
  return {
    n: post.length,
    ok,
    okRate: ok / post.length,
    errors: post.filter((l) => l.outcome === "error").length,
    p95Ms: ms[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)]!,
  };
}

export interface SetResult {
  base: Metrics;
  rr: Metrics;
  gl: GainsLosses;
}
export interface DecisionInput {
  s1: SetResult;
  s2: SetResult;
  ordinary: SetResult;
  real: RealUse;
  /** `reranker.e2e` et canari `voice.e2e` ×10 verts avec le worker actif, le jour de la mesure. */
  e2eAndCanary: boolean;
}
export interface Decision {
  bars: { A: boolean; B: boolean; C: boolean; D: boolean | null; E: boolean };
  missed: string[];
  verdict: "utile_en_usage" | "non_demontre" | "non_mesurable";
}

export function decisionVerdict(i: DecisionInput): Decision {
  const A = i.s1.rr.at1 >= i.s1.base.at1 + BARS.aGainAt1 && i.s1.rr.at3 >= i.s1.base.at3 && i.s1.rr.mrr >= i.s1.base.mrr;
  const B = i.s2.rr.at1 >= i.s2.base.at1 + BARS.bGainAt1 && i.s2.rr.at3 >= i.s2.base.at3;
  const C =
    i.ordinary.rr.at1 >= i.ordinary.base.at1 &&
    i.ordinary.gl.losses <= i.ordinary.gl.gains &&
    i.s1.gl.losses <= BARS.cMaxLossesS1 &&
    i.s2.gl.losses <= i.s2.gl.gains;
  const D = i.real.n < BARS.dMinLines ? null : i.real.okRate >= BARS.dMinOkRate && i.real.p95Ms <= BARS.dMaxP95Ms && i.real.errors === 0;
  const E = i.e2eAndCanary;
  const bars = { A, B, C, D, E };
  const missed = (Object.entries(bars) as [string, boolean | null][]).filter(([, v]) => v === false).map(([k]) => k);
  const verdict = missed.length > 0 ? "non_demontre" : D === null ? "non_mesurable" : "utile_en_usage";
  return { bars, missed, verdict };
}
