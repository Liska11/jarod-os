// Bench Q15 : le verdict applique le critère figé (10⁴ ET 10⁵, contre memory ET int8), sans victoire par défaut ;
// clause P2 amendée le 2026-09-29 (« au moins égal à la recherche exacte », DECISIONS).
import { describe, expect, it } from "vitest";
import { q15Verdict, type VerdictRun } from "../bench/q15-verdict.js";

// Run préliminaire à 10⁴ du 2026-09-28 (embeddings en cours en parallèle), `.work/q15-bench-…16-15-42…json`.
const at1e4: VerdictRun[] = [
  { engine: "memory", size: 10_000, p95Ms: 11.056, ramMb: 45.2, at3: 188, p2At3: 24, p2: 24 },
  { engine: "int8", size: 10_000, p95Ms: 7.071, ramMb: 13.4, at3: 188, p2At3: 24, p2: 24 },
  { engine: "turbovec-4", size: 10_000, p95Ms: 0.779, ramMb: 14.1, at3: 188, p2At3: 24, p2: 24 },
  { engine: "turbovec-2", size: 10_000, p95Ms: 0.47, ramMb: 11.5, at3: 189, p2At3: 24, p2: 24 },
];
const at1e5 = (patch: Partial<VerdictRun> = {}): VerdictRun[] => [
  { engine: "memory", size: 100_000, p95Ms: 120, ramMb: 450, at3: 180, p2At3: 24, p2: 24 },
  { engine: "int8", size: 100_000, p95Ms: 70, ramMb: 110, at3: 180, p2At3: 24, p2: 24 },
  { engine: "turbovec-2", size: 100_000, p95Ms: 3, ramMb: 40, at3: 180, p2At3: 24, p2: 24, ...patch },
];

describe("verdict d'adoption Q15", () => {
  it("run préliminaire à 10⁴ : turbovec-4 perd contre int8 sur la RAM, même sans 10⁵", () => {
    const v = q15Verdict("turbovec-4", at1e4);
    expect(v.verdict).toBe("perdu");
    expect(v.reasons).toContain("10000 : RAM 14.1 Mo ≥ int8 13.4 Mo");
  });

  it("une taille absente donne « incomplet », jamais « gagné »", () => {
    expect(q15Verdict("turbovec-2", at1e4)).toMatchObject({ verdict: "incomplet", reasons: ["100000 : mesure absente"] });
  });

  it("gagné seulement si chaque condition tient aux deux tailles", () => {
    expect(q15Verdict("turbovec-2", [...at1e4, ...at1e5()])).toEqual({ engine: "turbovec-2", verdict: "gagné", reasons: [] });
  });

  it("égalité = pas de victoire ; rappel@3 sous memory ou P2 incomplet = perdu", () => {
    expect(q15Verdict("turbovec-2", [...at1e4, ...at1e5({ p95Ms: 70 })]).verdict).toBe("perdu");
    expect(q15Verdict("turbovec-2", [...at1e4, ...at1e5({ ramMb: 110 })]).verdict).toBe("perdu");
    expect(q15Verdict("turbovec-2", [...at1e4, ...at1e5({ at3: 179 })]).reasons).toEqual(["100000 : rappel@3 179 < memory 180"]);
    expect(q15Verdict("turbovec-2", [...at1e4, ...at1e5({ p2At3: 23 })]).reasons).toEqual(["100000 : P2 23/24 < exacte 24/24"]);
  });

  it("clause P2 amendée : égaler la recherche exacte suffit, même sous 24/24", () => {
    const exact22 = at1e5().map((r) => ({ ...r, p2At3: 22 }));
    expect(q15Verdict("turbovec-2", [...at1e4, ...exact22]).verdict).toBe("gagné");
  });

  // Bench final du 2026-09-28 (machine calme, médiane de 3), `.work/q15-bench-2026-09-28T20-39-48-780Z.json`.
  const final: VerdictRun[] = [
    { engine: "memory", size: 10_000, p95Ms: 17.509, ramMb: 44.8, at3: 188, p2At3: 24, p2: 24 },
    { engine: "int8", size: 10_000, p95Ms: 12.386, ramMb: 15.9, at3: 188, p2At3: 24, p2: 24 },
    { engine: "turbovec-4", size: 10_000, p95Ms: 0.901, ramMb: 14.1, at3: 188, p2At3: 24, p2: 24 },
    { engine: "turbovec-2", size: 10_000, p95Ms: 0.558, ramMb: 11.5, at3: 189, p2At3: 24, p2: 24 },
    { engine: "memory", size: 100_000, p95Ms: 156.611, ramMb: 427.4, at3: 163, p2At3: 22, p2: 24 },
    { engine: "int8", size: 100_000, p95Ms: 108.702, ramMb: 103.8, at3: 163, p2At3: 22, p2: 24 },
    { engine: "turbovec-4", size: 100_000, p95Ms: 1.488, ramMb: 94.7, at3: 163, p2At3: 22, p2: 24 },
    { engine: "turbovec-2", size: 100_000, p95Ms: 0.923, ramMb: 70.1, at3: 161, p2At3: 22, p2: 24 },
  ];

  it("bench final sous la clause amendée : turbovec-4 gagne, turbovec-2 reste perdant (rappel@3)", () => {
    expect(q15Verdict("turbovec-4", final)).toEqual({ engine: "turbovec-4", verdict: "gagné", reasons: [] });
    expect(q15Verdict("turbovec-2", final)).toEqual({ engine: "turbovec-2", verdict: "perdu", reasons: ["100000 : rappel@3 161 < memory 163"] });
  });
});
