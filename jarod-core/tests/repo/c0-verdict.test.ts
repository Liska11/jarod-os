// Le verdict C0-a applique le critère figé le 2026-09-29 (DECISIONS) : chaque condition, seule, le fait basculer.
import { describe, expect, it } from "vitest";
import { c0Verdict, type C0Run, type Recall, type SetResult } from "../bench/c0-verdict.js";

const r = (at1: number, at3: number, at10: number): Recall => ({ at1, at3, at10 });
const set = (n: number, dense: Recall, hybrid: Recall): SetResult => ({ n, dense, fts: r(0, 0, 0), hybrid });
const good = (size: number): C0Run => ({
  size,
  A: set(24, r(20, 22, 23), r(20, 22, 23)),
  B: set(176, r(170, 174, 176), r(171, 175, 176)),
  D: set(200, r(100, 120, 140), r(150, 170, 190)),
  ftsP95Ms: [6, 7, 8],
});
const runs = (edit: (r: C0Run) => void = () => {}): C0Run[] => [good(10_000), good(100_000)].map((x) => (edit(x), x));

describe("c0Verdict", () => {
  it("toutes les barres tenues : utile", () => {
    expect(c0Verdict(runs())).toEqual({ verdict: "utile", reasons: [] });
  });

  it("(a) une régression @3 sur A ou sur B, à une seule taille : non utile", () => {
    let v = c0Verdict(runs((x) => x.size === 10_000 && (x.A.hybrid = r(20, 21, 23))));
    expect(v.verdict).toBe("non utile");
    expect(v.reasons.join()).toMatch(/10000 : régression sur A/);
    v = c0Verdict(runs((x) => x.size === 100_000 && (x.B.hybrid = r(171, 173, 176))));
    expect(v.reasons.join()).toMatch(/100000 : régression sur B/);
  });

  it("égalité avec le dense sur A et B : pas de régression", () => {
    expect(c0Verdict(runs((x) => ((x.A.hybrid = { ...x.A.dense }), (x.B.hybrid = { ...x.B.dense })))).verdict).toBe("utile");
  });

  it("(b) le gain sur D doit atteindre 5 points de rappel@10 (10 requêtes sur 200) : 9 ne suffit pas, 10 suffit", () => {
    expect(c0Verdict(runs((x) => (x.D.hybrid = r(150, 170, 149)))).verdict).toBe("non utile");
    expect(c0Verdict(runs((x) => (x.D.hybrid = r(150, 170, 150)))).verdict).toBe("utile");
  });

  it("(c) p95 du volet FTS5 : médiane des passages, borne incluse, seulement à 10⁵", () => {
    expect(c0Verdict(runs((x) => (x.ftsP95Ms = [9, 10, 30]))).verdict).toBe("utile");
    const v = c0Verdict(runs((x) => (x.ftsP95Ms = [9, 11, 12])));
    expect(v.verdict).toBe("non utile");
    expect(v.reasons.join()).toMatch(/100000 : p95 du volet FTS5 11\.00 ms > 10 ms/);
    expect(c0Verdict(runs((x) => x.size === 10_000 && (x.ftsP95Ms = [50, 60, 70]))).verdict).toBe("utile");
  });

  it("une taille ou une mesure absente : incomplet, jamais une victoire", () => {
    expect(c0Verdict([good(10_000)]).verdict).toBe("incomplet");
    expect(c0Verdict(runs((x) => x.size === 100_000 && (x.ftsP95Ms = []))).verdict).toBe("incomplet");
  });

  it("toutes les raisons sont listées", () => {
    const v = c0Verdict(runs((x) => ((x.A.hybrid = r(0, 0, 0)), (x.D.hybrid = r(0, 0, 0)))));
    expect(v.reasons).toHaveLength(4);
  });
});
