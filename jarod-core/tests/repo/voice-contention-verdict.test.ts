// Le verdict de la contention voix applique le protocole figé le 2026-10-01 (DECISIONS) : chaque règle, seule, le fait basculer.
import { describe, expect, it } from "vitest";
import { fisherLess, median, type Pass, voiceContentionVerdict } from "../bench/voice-contention-verdict.js";

const mk = (condition: "A" | "B", ok: number, n: number, over: Partial<Pass> = {}): Pass[] =>
  Array.from({ length: n }, (_, i) => ({ condition, outcome: i < ok ? "OK" : i % 2 ? "CRASH" : "FAIL", sttMs: 2700, wakeAtMs: 2400, ...(condition === "B" ? { docsDuring: 2 } : {}), ...over }) as Pass);

describe("test exact de Fisher unilatéral", () => {
  it("valeurs de référence (calculées à la main)", () => {
    // 2x2 [[A ok 8, ko 2], [B ok 3, ko 7]] : P(X_B <= 3 | marges) = Σ C(10,x)·C(10,11−x)/C(20,11) = 0,034889 (énumération indépendante).
    expect(fisherLess(8, 10, 3, 10)).toBeCloseTo(0.034889, 5);
    expect(fisherLess(5, 10, 5, 10)).toBeGreaterThan(0.5);
    expect(fisherLess(10, 10, 10, 10)).toBe(1);
    expect(fisherLess(0, 5, 0, 5)).toBe(1);
  });

  it("symétrie et bornes : plus B réussit moins, plus p est petit ; p ≤ 1", () => {
    const ps = [30, 27, 24, 20, 15, 10].map((okB) => fisherLess(28, 30, okB, 30));
    for (let i = 1; i < ps.length; i++) expect(ps[i]!).toBeLessThanOrEqual(ps[i - 1]!);
    expect(Math.max(...ps)).toBeLessThanOrEqual(1);
  });
});

describe("verdict", () => {
  it("médiane", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("même réussite, mêmes latences : pas de dégradation démontrée (et non « absence »)", () => {
    const v = voiceContentionVerdict([...mk("A", 27, 30), ...mk("B", 26, 30)]);
    expect(v.verdict).toBe("pas de dégradation démontrée");
    expect(v.n).toEqual({ A: 30, B: 30 });
  });

  it("chute nette de la réussite sous charge (28/30 → 14/30) : dégradation, p < 0,05", () => {
    const v = voiceContentionVerdict([...mk("A", 28, 30), ...mk("B", 14, 30)]);
    expect(v.verdict).toBe("dégradation");
    expect(v.fisherP).toBeLessThan(0.05);
    expect(v.reasons.join(" ")).toContain("Fisher");
  });

  it("B réussit MIEUX qu'A : jamais une dégradation", () => {
    expect(voiceContentionVerdict([...mk("A", 15, 30), ...mk("B", 28, 30)]).verdict).toBe("pas de dégradation démontrée");
  });

  it("latences : > 1,10× sur la transcription OU sur le mot d'activation = dégradation ; 1,10× pile passe", () => {
    const base = mk("A", 30, 30);
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30, { sttMs: 2970 })]).verdict).toBe("pas de dégradation démontrée");
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30, { sttMs: 2971 })]).verdict).toBe("dégradation");
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30, { wakeAtMs: 2700 })]).verdict).toBe("dégradation");
  });

  it("invalide : base instable (< 50 % à vide), charge absente (< 90 % des passages B avec un document), condition vide", () => {
    expect(voiceContentionVerdict([...mk("A", 10, 30), ...mk("B", 10, 30)]).verdict).toBe("invalide");
    expect(voiceContentionVerdict([...mk("A", 30, 30), ...mk("B", 30, 30, { docsDuring: 0 })]).verdict).toBe("invalide");
    expect(voiceContentionVerdict(mk("A", 30, 30)).verdict).toBe("invalide");
    expect(voiceContentionVerdict([]).verdict).toBe("invalide");
  });

  it("l'invalidité PRIME sur une dégradation apparente", () => {
    expect(voiceContentionVerdict([...mk("A", 10, 30), ...mk("B", 0, 30)]).verdict).toBe("invalide");
  });

  it("requirePause : la pause doit avoir eu lieu (pausedMs > 0) dans ≥ 90 % des passages B, sinon INVALIDE", () => {
    const base = mk("A", 30, 30);
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30, { pausedMs: 3000 })], { requirePause: true }).verdict).toBe("pas de dégradation démontrée");
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30, { pausedMs: 0 })], { requirePause: true }).verdict).toBe("invalide");
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30)], { requirePause: true }).verdict).toBe("invalide");
    // 27/30 passages avec pause = 90 % pile : valide ; 26/30 : invalide.
    const share = (n: number) => [...base, ...mk("B", 30, 30).map((p, i) => ({ ...p, pausedMs: i < n ? 1000 : 0 }))];
    expect(voiceContentionVerdict(share(27), { requirePause: true }).verdict).toBe("pas de dégradation démontrée");
    expect(voiceContentionVerdict(share(26), { requirePause: true }).verdict).toBe("invalide");
    // Sans l'option, la pause n'est pas exigée (protocole d'origine, charge hors de l'application).
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30)]).verdict).toBe("pas de dégradation démontrée");
  });

  it("expectedDevices : ≥ 90 % des passages B doivent porter l'affectation d'appareils attendue, sinon INVALIDE", () => {
    const base = mk("A", 30, 30);
    const want = '{"128":"GPU.0","512":"NPU"}';
    const other = '{"128":"NPU","512":"GPU.0"}';
    const share = (n: number) => [...base, ...mk("B", 30, 30).map((p, i) => ({ ...p, embDevices: i < n ? want : other }))];
    expect(voiceContentionVerdict(share(30), { expectedDevices: want }).verdict).toBe("pas de dégradation démontrée");
    expect(voiceContentionVerdict(share(27), { expectedDevices: want }).verdict).toBe("pas de dégradation démontrée");
    expect(voiceContentionVerdict(share(26), { expectedDevices: want }).verdict).toBe("invalide");
    expect(voiceContentionVerdict([...base, ...mk("B", 30, 30)], { expectedDevices: want }).verdict).toBe("invalide"); // métriques absentes
    expect(voiceContentionVerdict(share(0)).verdict).toBe("pas de dégradation démontrée"); // option absente : non exigée
  });

  it("les plantages 0xC0000005 sont comptés à part", () => {
    const v = voiceContentionVerdict([...mk("A", 24, 30), ...mk("B", 24, 30)]);
    expect(v.crash.A + v.crash.B).toBeGreaterThan(0);
  });
});
