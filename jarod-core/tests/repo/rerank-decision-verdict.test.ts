// SPECS-P5-RERANKER.md §10 : fonctions PURES de la passe de décision d'activation. Barres A à E approuvées le 2026-10-02 avec les seuils ◆ :
// A +3 · B +2 · C pertes ≤ gains (≤ 1 perte sur S1) · D ≥ 30 lignes. Écrit AVANT le banc.
import { describe, expect, it } from "vitest";
import { BARS, decisionVerdict, gainsLosses, realUseStats, setMetrics } from "../bench/rerank-decision-verdict.js";

const R = (xs: (number | null)[]) => xs; // rangs du 1er passage-réponse (null = absent des résultats)

describe("setMetrics : @1, @3, MRR sur des rangs", () => {
  it("compte les rangs ≤ 1 et ≤ 3 ; MRR = moyenne de 1/rang (absent = 0) ; arrondi à 4 décimales", () => {
    expect(setMetrics(R([1, 2, 3, 4, null]))).toEqual({ n: 5, at1: 1, at3: 3, mrr: Number(((1 + 0.5 + 1 / 3 + 0.25 + 0) / 5).toFixed(4)) });
    expect(setMetrics(R([]))).toEqual({ n: 0, at1: 0, at3: 0, mrr: 0 });
  });
});

describe("gainsLosses : @1 sans reclassement contre @1 avec", () => {
  it("gagnée = rang dense > 1 et reranké = 1 ; perdue = dense = 1 et reranké ≠ 1 ; les autres sont neutres", () => {
    const base = R([1, 1, 2, 4, null, 1]);
    const rr = R([1, 3, 1, 1, null, null]);
    expect(gainsLosses(base, rr)).toEqual({ gains: 2, losses: 2 }); // Q3 et Q4 gagnées ; Q2 et Q6 perdues
  });
  it("exige des listes de même longueur", () => {
    expect(() => gainsLosses(R([1]), R([1, 2]))).toThrow();
  });
});

describe("realUseStats : lignes du rapport fantôme POSTÉRIEURES à la coupe", () => {
  const cut = Date.parse("2026-10-02T15:01:46Z");
  const line = (t: number, outcome: string, ms: number) => ({ t, outcome, ms });
  it("ne garde que les lignes strictement postérieures ; compte ok / autres ; p95 des durées ; erreurs", () => {
    const lines = [line(cut - 5, "ok", 9_999), line(cut, "ok", 9_999), line(cut + 1, "ok", 3_100), line(cut + 2, "ok", 3_200), line(cut + 3, "timeout", 4_000), line(cut + 4, "error", 10)];
    expect(realUseStats(lines, cut)).toEqual({ n: 4, ok: 2, okRate: 0.5, errors: 1, p95Ms: 4_000 });
  });
  it("aucune ligne → n = 0, taux 0, p95 0", () => {
    expect(realUseStats([], cut)).toEqual({ n: 0, ok: 0, okRate: 0, errors: 0, p95Ms: 0 });
  });
});

const base = { n: 22, at1: 16, at3: 19, mrr: 0.8068 };
const good = {
  s1: { base, rr: { n: 22, at1: 20, at3: 20, mrr: 0.9091 }, gl: { gains: 4, losses: 0 } },
  s2: { base: { n: 39, at1: 25, at3: 33, mrr: 0.8 }, rr: { n: 39, at1: 28, at3: 34, mrr: 0.85 }, gl: { gains: 4, losses: 1 } },
  ordinary: { base: { n: 29, at1: 20, at3: 26, mrr: 0.85 }, rr: { n: 29, at1: 21, at3: 26, mrr: 0.88 }, gl: { gains: 2, losses: 1 } },
  real: { n: 40, ok: 39, okRate: 0.975, errors: 0, p95Ms: 3_300 },
  e2eAndCanary: true,
};
const clone = () => structuredClone(good);

describe("BARS (figées) et decisionVerdict", () => {
  it("les seuils ◆ approuvés le 2026-10-02", () => {
    expect(BARS).toEqual({ aGainAt1: 3, bGainAt1: 2, cMaxLossesS1: 1, dMinLines: 30, dMinOkRate: 0.95, dMaxP95Ms: 4_000 });
  });

  it("tout tenu ⇒ « utile_en_usage » (jamais une activation : la décision reste à l'utilisateur)", () => {
    const v = decisionVerdict(good);
    expect(v.bars).toEqual({ A: true, B: true, C: true, D: true, E: true });
    expect(v.verdict).toBe("utile_en_usage");
  });

  it("A : +2 seulement sur S1 ⇒ manquée ; @3 en baisse ⇒ manquée ; MRR en baisse ⇒ manquée ; exactement +3 ⇒ tenue (égalité de seuil)", () => {
    let x = clone();
    x.s1.rr.at1 = 19;
    expect(decisionVerdict(x).bars.A).toBe(true);
    x = clone();
    x.s1.rr.at1 = 18;
    expect(decisionVerdict(x).bars.A).toBe(false);
    x = clone();
    x.s1.rr.at3 = 18;
    expect(decisionVerdict(x).bars.A).toBe(false);
    x = clone();
    x.s1.rr.mrr = 0.8;
    expect(decisionVerdict(x).bars.A).toBe(false);
  });

  it("B : +1 seulement sur S2 ⇒ manquée ; @3 en baisse ⇒ manquée ; exactement +2 ⇒ tenue", () => {
    let x = clone();
    x.s2.rr.at1 = 27;
    expect(decisionVerdict(x).bars.B).toBe(true);
    x.s2.rr.at1 = 26;
    expect(decisionVerdict(x).bars.B).toBe(false);
    x = clone();
    x.s2.rr.at3 = 32;
    expect(decisionVerdict(x).bars.B).toBe(false);
  });

  it("C : pertes > gains sur les ordinaires ⇒ manquée ; @1 ordinaire en baisse ⇒ manquée ; 2 pertes sur S1 ⇒ manquée ; pertes > gains sur S2 ⇒ manquée", () => {
    let x = clone();
    x.ordinary.gl = { gains: 1, losses: 2 };
    expect(decisionVerdict(x).bars.C).toBe(false);
    x = clone();
    x.ordinary.rr.at1 = 19;
    expect(decisionVerdict(x).bars.C).toBe(false);
    x = clone();
    x.s1.gl = { gains: 4, losses: 2 };
    expect(decisionVerdict(x).bars.C).toBe(false);
    x = clone();
    x.s2.gl = { gains: 2, losses: 3 };
    expect(decisionVerdict(x).bars.C).toBe(false);
    x = clone();
    x.s1.gl = { gains: 4, losses: 1 }; // exactement 1 perte sur S1 : tenue
    expect(decisionVerdict(x).bars.C).toBe(true);
  });

  it("D : moins de 30 lignes ⇒ « non mesurable » (pas un échec, pas de verdict) ; taux ok < 95 % ⇒ manquée ; p95 > 4 000 ms ⇒ manquée ; une erreur ⇒ manquée", () => {
    let x = clone();
    x.real = { n: 29, ok: 29, okRate: 1, errors: 0, p95Ms: 3_000 };
    const v = decisionVerdict(x);
    expect(v.bars.D).toBe(null);
    expect(v.verdict).toBe("non_mesurable");
    x = clone();
    x.real = { n: 40, ok: 37, okRate: 0.925, errors: 0, p95Ms: 3_000 };
    expect(decisionVerdict(x).bars.D).toBe(false);
    x = clone();
    x.real.p95Ms = 4_001;
    expect(decisionVerdict(x).bars.D).toBe(false);
    x = clone();
    x.real.errors = 1;
    expect(decisionVerdict(x).bars.D).toBe(false);
    x = clone();
    x.real = { n: 30, ok: 29, okRate: 29 / 30, errors: 0, p95Ms: 4_000 }; // 96,7 % et p95 = 4 000 : tenue
    expect(decisionVerdict(x).bars.D).toBe(true);
  });

  it("E : e2e ou canari non verts ⇒ manquée", () => {
    const x = clone();
    x.e2eAndCanary = false;
    expect(decisionVerdict(x).bars.E).toBe(false);
  });

  it("une seule barre manquée ⇒ « non_demontre » ; la liste des barres manquées est rendue ; aucun réglage n'est proposé", () => {
    const x = clone();
    x.s2.rr.at1 = 25;
    const v = decisionVerdict(x);
    expect(v.verdict).toBe("non_demontre");
    expect(v.missed).toEqual(["B"]);
    expect(JSON.stringify(v)).not.toMatch(/activer|active/i);
  });
});
