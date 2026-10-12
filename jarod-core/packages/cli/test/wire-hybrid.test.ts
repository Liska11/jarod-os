// SPECS-P5-HYBRID.md §2.3 : `wire-hybrid` allume le drapeau `ecosystem.hybrid` d'un profil, rien d'autre. Simulation par défaut ; ne touche ni au reranker
// ni à son mode, ni aux autres drapeaux ; idempotent ; ne dit « fait » qu'après relecture.
import { describe, expect, it } from "vitest";
import { applyHybridFlag, planHybrid } from "../src/wire-hybrid.js";

describe("applyHybridFlag", () => {
  it("allume hybrid et ne change AUCUNE autre clé (reranker, mode, budgets, parseur)", () => {
    const eco = { vectorIndex: "memory", documentParser: "docling", reranker: "bge-reranker-v2-m3-npu", rerankTopN: 16, rerankDeadlineMs: 4000, rerankMode: "shadow", hybrid: "off" };
    expect(applyHybridFlag(eco)).toEqual({ ...eco, hybrid: "on" });
  });

  it("idempotent, et ne fait pas passer un reranker « active » en fantôme ni l'inverse", () => {
    const eco = { rerankMode: "active", hybrid: "on" };
    expect(applyHybridFlag(eco)).toEqual(eco);
    expect(applyHybridFlag(applyHybridFlag({ rerankMode: "shadow" }))).toEqual({ rerankMode: "shadow", hybrid: "on" });
  });

  it("ajoute la clé si elle manque", () => {
    expect(applyHybridFlag({})).toEqual({ hybrid: "on" });
  });
});

describe("planHybrid", () => {
  it("décrit avant/après sans rien écrire", () => {
    const plan = planHybrid({ hybrid: "off", reranker: "off" });
    expect(plan.before).toBe("off");
    expect(plan.after).toBe("on");
    expect(plan.changes).toBe(true);
  });

  it("déjà allumé : aucun changement à faire", () => {
    expect(planHybrid({ hybrid: "on" })).toMatchObject({ before: "on", after: "on", changes: false });
  });

  it("clé absente : lue comme éteinte", () => {
    expect(planHybrid({})).toMatchObject({ before: "off", after: "on", changes: true });
  });
});
