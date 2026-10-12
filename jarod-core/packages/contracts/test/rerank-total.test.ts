// SPECS-P5-RERANKER-ACTIVE.md Q4 : le rapport de reclassement porte la durée TOTALE de la recherche servie (`totalMs`, nombre, optionnel).
// Les lignes déjà écrites (sans ce champ) restent valides ; aucun texte libre n'entre dans l'entrée.
import { describe, expect, it } from "vitest";
import { RerankShadowEntry } from "../src/index.js";

const ENGINE = { name: "bge-reranker-v2-m3", version: "int8-b8x512", device: "NPU" };
const OLD = { t: 1790953400000, profile: "default", engine: ENGINE, ms: 3241, outcome: "ok", mode: "shadow", candidates: [4, 9, 2], reranked: [9, 2, 4] };

describe("RerankShadowEntry.totalMs", () => {
  it("une ligne ANCIENNE (sans totalMs) reste valide et ressort à l'identique", () => {
    expect(RerankShadowEntry.parse(OLD)).toEqual(OLD);
    expect("totalMs" in RerankShadowEntry.parse(OLD)).toBe(false);
  });

  it("accepte un nombre positif ou nul, entier ou non", () => {
    for (const totalMs of [0, 62, 3304, 1234.5]) expect(RerankShadowEntry.parse({ ...OLD, totalMs }).totalMs).toBe(totalMs);
  });

  it("refuse ce qui n'est pas une durée : négatif, texte, null, booléen, objet", () => {
    for (const totalMs of [-1, "3304", null, true, { ms: 1 }, Number.NaN]) {
      expect(RerankShadowEntry.safeParse({ ...OLD, totalMs }).success, JSON.stringify(totalMs)).toBe(false);
    }
  });

  it("reste un objet STRICT : aucune autre clé (ni texte de requête, ni nom approchant)", () => {
    for (const extra of [{ query: "texte" }, { total_ms: 1 }, { totalms: 1 }, { total: 1 }]) {
      expect(RerankShadowEntry.safeParse({ ...OLD, totalMs: 10, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
  });

  it("compatible avec toutes les issues (ok, timeout, paused, stale) et les deux modes", () => {
    for (const outcome of ["ok", "timeout", "unavailable", "error", "paused", "stale"] as const)
      for (const mode of ["shadow", "active"] as const)
        expect(RerankShadowEntry.safeParse({ ...OLD, outcome, mode, totalMs: 5, ...(outcome === "ok" ? {} : { reranked: [], reason: "RERANKER_X" }) }).success, `${outcome}/${mode}`).toBe(true);
  });
});
