// Décision du 2026-10-03 : `taille × 1,2` reste le repli de `recommendModels` et se dit « poids seulement, pas un fit KV ».
// `LOCAL_CATALOG` n'a pas d'en-tête GGUF : `gguf-fit` n'y est pas branché (garde ci-dessous).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_CATALOG, WEIGHTS_ONLY_FIT_LABEL, memoryBudgetGb, recommendModels, type Hardware } from "../src/local.js";

const hw = (vramGb: number): Hardware =>
  ({ platform: "win32", arch: "x64", ramGb: 64, appleSilicon: false, gpus: [{ name: "NVIDIA RTX 4000 Ada Generation", vramGb }] }) as unknown as Hardware;

describe("recommendModels — repli « poids seulement »", () => {
  it("le libellé est exact", () => {
    expect(WEIGHTS_ONLY_FIT_LABEL).toBe("poids seulement, pas un fit KV");
  });

  it("chaque suggestion porte le libellé du repli", () => {
    const out = recommendModels(hw(20));
    expect(out.length).toBe(LOCAL_CATALOG.length);
    for (const m of out) expect(m.fitBasis).toBe(WEIGHTS_ONLY_FIT_LABEL);
  });

  it("la règle est inchangée : taille × 1,2 contre le budget, « tight » jusqu'à ×1,4, sinon « too-big »", () => {
    const budget = memoryBudgetGb(hw(20)); // 20 Go de VRAM
    expect(budget).toBe(20);
    for (const m of recommendModels(hw(20))) {
      const need = m.sizeGb * 1.2;
      expect(m.fits).toBe(need <= budget ? "good" : need <= budget * 1.4 ? "tight" : "too-big");
    }
    expect(recommendModels(hw(20)).find((m) => m.name === "qwen2.5:14b")!.fits).toBe("good"); // 9 × 1,2 = 10,8 ≤ 20
    expect(recommendModels(hw(20)).find((m) => m.name === "llama3.3:70b")!.fits).toBe("too-big"); // 43 × 1,2 = 51,6 > 28
  });

  it("le contexte n'entre pas dans la règle : la fonction ne prend que le matériel (c'est ce que dit le libellé)", () => {
    expect(recommendModels.length).toBe(1); // un seul argument : le matériel, pas de contexte
  });

  it("garde : local.ts n'importe pas gguf-fit (LOCAL_CATALOG n'a pas d'en-tête GGUF)", () => {
    const src = readFileSync(new URL("../src/local.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/gguf-fit/);
    expect(src).not.toMatch(/import\([^)]*gguf-fit/);
  });
});
