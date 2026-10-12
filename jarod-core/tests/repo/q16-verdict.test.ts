// Bench Q16 : le verdict applique le critère figé le 2026-09-29 (fidélité, qualité FR, contexte), sans
// victoire par défaut ; les fixtures sont équilibrées et étiquetées (DECISIONS).
import { describe, expect, it } from "vitest";
import { effectOf, FIXTURES, INTENTS } from "../bench/q16-fixtures.js";
import { type Q16Measures, q16Verdict } from "../bench/q16-verdict.js";

const ok: Q16Measures = {
  patchedCpuMaxDiff: 0,
  dml: { agree: 120, total: 120, maxDiff: 2e-4 },
  frIntent: { laya: 50, bge: 45, total: 60 },
  frEffect: { laya: 50, majority: 36, total: 60 },
  longContext: { ok: true, maxTokens: 512, maxLen: 512 },
};

describe("verdict Q16", () => {
  it("toutes les conditions tenues : gagné", () => {
    expect(q16Verdict(ok)).toEqual({ verdict: "gagné", reasons: [] });
  });

  it("égalité avec l'alternative simple ou la classe majoritaire : perdu", () => {
    const v = q16Verdict({ ...ok, frIntent: { laya: 45, bge: 45, total: 60 }, frEffect: { laya: 36, majority: 36, total: 60 } });
    expect(v.verdict).toBe("perdu");
    expect(v.reasons).toEqual(["intent FR : Laya 45/60 ≤ bge-m3 45/60", "effet FR : Laya 36/60 ≤ classe majoritaire 36/60"]);
  });

  it("fidélité : une décision DirectML différente, un écart trop grand ou un graphe dérivé infidèle font perdre", () => {
    const v = q16Verdict({ ...ok, patchedCpuMaxDiff: 3e-4, dml: { agree: 119, total: 120, maxDiff: 2e-3 } });
    expect(v.verdict).toBe("perdu");
    expect(v.reasons).toEqual([
      "graphe dérivé : écart CPU 0.0003 > 0.0001",
      "DirectML : 119/120 décisions identiques au CPU",
      "DirectML : écart max 0.002 > 0.001",
    ]);
  });

  it("contexte long en erreur ou au-delà de max_len : perdu", () => {
    expect(q16Verdict({ ...ok, longContext: { ok: false, maxTokens: 600, maxLen: 512 } }).reasons).toEqual([
      "contexte long : erreur",
      "contexte long : 600 tokens > 512",
    ]);
  });

  it("mesure absente : incomplet, jamais gagné ; une condition manquée l'emporte", () => {
    expect(q16Verdict({ ...ok, dml: null })).toEqual({ verdict: "incomplet", reasons: ["DirectML : mesure absente"] });
    expect(q16Verdict({ ...ok, dml: null, frIntent: { laya: 1, bge: 2, total: 60 } }).verdict).toBe("perdu");
  });

  it("fixtures : 5 intents × 12, traductions présentes, classe majoritaire de l'effet = 36/60", () => {
    expect(FIXTURES).toHaveLength(60);
    for (const i of INTENTS) expect(FIXTURES.filter((f) => f.intent === i)).toHaveLength(12);
    expect(FIXTURES.every((f) => f.fr.trim() && f.en.trim() && f.fr !== f.en)).toBe(true);
    expect(new Set(FIXTURES.map((f) => f.fr)).size).toBe(60);
    expect(FIXTURES.filter((f) => !effectOf(f.intent))).toHaveLength(36);
  });
});
