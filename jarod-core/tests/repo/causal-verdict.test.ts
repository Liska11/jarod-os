// SPECS-P5-CAUSAL.md §5 et §9 : verdict de la mesure de la mémoire causale — fonction PURE, barres validées par l'utilisateur AVANT toute mesure.
// Égalité ≠ victoire ; chaque condition manquée est listée ; un jeu insuffisant ne donne PAS de verdict.
import { describe, expect, it } from "vitest";
import { BARS, causalVerdict } from "../bench/causal-verdict.js";

const m = (o: Partial<Parameters<typeof causalVerdict>[0]> = {}) => ({ targets: 200, baselineHits: 100, systemHits: 120, offTargets: 100, falseAlarms: 10, ...o });

describe("causalVerdict", () => {
  it("les barres sont celles validées : 150 cibles (plancher), +10 points de rappel@3, précision hors cibles ≥ 80 %", () => {
    expect(BARS).toEqual({ minTargets: 150, minGainPoints: 10, minPrecisionPercent: 80 });
  });

  it("victoire : gain ≥ 10 points ET précision ≥ 80 % ET assez de cibles", () => {
    const v = causalVerdict(m());
    expect(v.verdict).toBe("victoire");
    expect(v.gainPoints).toBe(10);
    expect(v.missed).toEqual([]);
  });

  it("le gain pile à 10 points compte ; juste en dessous non (aucune égalité à la référence ne suffit)", () => {
    expect(causalVerdict(m({ systemHits: 120 })).verdict).toBe("victoire");
    const below = causalVerdict(m({ systemHits: 119 }));
    expect(below.verdict).toBe("defaite");
    expect(below.missed).toEqual([expect.stringMatching(/gain/)]);
    const equal = causalVerdict(m({ systemHits: 100 }));
    expect(equal.verdict).toBe("defaite");
    const worse = causalVerdict(m({ systemHits: 80 }));
    expect(worse.verdict).toBe("defaite");
  });

  it("précision hors cibles : 80 % pile passe, 79 % échoue ; la condition manquée est nommée", () => {
    expect(causalVerdict(m({ falseAlarms: 20 })).verdict).toBe("victoire");
    const v = causalVerdict(m({ falseAlarms: 21 }));
    expect(v.verdict).toBe("defaite");
    expect(v.missed).toEqual([expect.stringMatching(/précision/)]);
  });

  it("deux conditions manquées sont listées toutes les deux", () => {
    const v = causalVerdict(m({ systemHits: 105, falseAlarms: 50 }));
    expect(v.verdict).toBe("defaite");
    expect(v.missed).toHaveLength(2);
  });

  it("DEUX RÉGIMES du 150 : ≥ 150 cibles = verdict FINAL ; en dessous, résultat RENDU et marqué « faible effectif » (réexamen avec l'utilisateur avant toute action)", () => {
    const low = causalVerdict(m({ targets: 149, baselineHits: 10, systemHits: 140 }));
    expect(low.verdict).toBe("faible_effectif");
    expect(low.final).toBe(false);
    expect(low.gainPoints).not.toBeNull(); // les chiffres sont rendus, pas masqués
    expect(low.precisionPercent).not.toBeNull();
    expect(low.missed).toEqual([]); // barres de gain et de précision tenues : dit à part du verdict
    expect(low.notes).toEqual([expect.stringMatching(/faible effectif/i)]);
    // même en dessous de 150, les barres manquées restent LISTÉES pour l'examen, sans verdict final
    const lowAndMissed = causalVerdict(m({ targets: 100, baselineHits: 50, systemHits: 52 }));
    expect(lowAndMissed.verdict).toBe("faible_effectif");
    expect(lowAndMissed.missed).toEqual([expect.stringMatching(/gain/)]);
    // à partir de 150 : verdict final
    const high = causalVerdict(m({ targets: 150, baselineHits: 75, systemHits: 90 }));
    expect(high.verdict).toBe("victoire");
    expect(high.final).toBe(true);
    expect(causalVerdict(m({ targets: 150, baselineHits: 75, systemHits: 80 })).final).toBe(true);
  });

  it("données absentes ou incohérentes : INCOMPLET, jamais une victoire par défaut", () => {
    expect(causalVerdict(m({ offTargets: 0, falseAlarms: 0 })).verdict).toBe("incomplet");
    expect(causalVerdict(m({ systemHits: 201 })).verdict).toBe("incomplet");
    expect(causalVerdict(m({ falseAlarms: 101 })).verdict).toBe("incomplet");
    expect(causalVerdict(m({ targets: 0, baselineHits: 0, systemHits: 0 })).verdict).toBe("incomplet");
  });
});
