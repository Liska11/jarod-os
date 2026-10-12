// Gate P4 « déport NPU » : le verdict lit chaque métrique dans son sens de dégradation.
import { describe, expect, it } from "vitest";
import { npuVerdict } from "../gates/p4-npu-verdict.js";

const idle = { promptMs: 100, predictedPerSecond: 30 };

describe("verdict de la gate P4 déport NPU", () => {
  it("mesure de référence du 2026-09-28 (0,4 % / 2,2 % / 1,2 %) : verte", () => {
    const v = npuVerdict({ promptMs: 86, predictedPerSecond: 30.46 }, { promptMs: 88, predictedPerSecond: 30.16 }, { promptMs: 87, predictedPerSecond: 30.1 });
    expect(v.verdict).toBe("verte");
    expect(v.genSlowdown).toBeCloseTo(0.004, 3);
    expect(v.promptSlowdown).toBeCloseTo(0.017, 3);
  });

  it("génération : c'est une BAISSE des tok/s qui dégrade ; une hausse n'échoue jamais", () => {
    expect(npuVerdict(idle, { promptMs: 100, predictedPerSecond: 26.9 }, idle)).toMatchObject({ verdict: "rouge" });
    expect(npuVerdict(idle, { promptMs: 100, predictedPerSecond: 27.1 }, idle)).toMatchObject({ verdict: "verte" });
    expect(npuVerdict(idle, { promptMs: 100, predictedPerSecond: 60 }, idle)).toMatchObject({ verdict: "verte" });
  });

  it("prompt : c'est une HAUSSE des ms qui dégrade ; une baisse n'échoue jamais", () => {
    expect(npuVerdict(idle, { promptMs: 110.5, predictedPerSecond: 30 }, idle)).toMatchObject({ verdict: "rouge" });
    expect(npuVerdict(idle, { promptMs: 109.5, predictedPerSecond: 30 }, idle)).toMatchObject({ verdict: "verte" });
    expect(npuVerdict(idle, { promptMs: 20, predictedPerSecond: 30 }, idle)).toMatchObject({ verdict: "verte" });
  });

  it("écart > 5 % entre les deux séries à vide (l'une ou l'autre métrique) : invalide, jamais rouge", () => {
    const worse = { promptMs: 200, predictedPerSecond: 10 };
    expect(npuVerdict(idle, worse, { promptMs: 100, predictedPerSecond: 33 })).toMatchObject({ verdict: "invalide" });
    expect(npuVerdict(idle, worse, { promptMs: 106, predictedPerSecond: 30 })).toMatchObject({ verdict: "invalide" });
    expect(npuVerdict(idle, worse, { promptMs: 104, predictedPerSecond: 31 }).verdict).toBe("rouge");
  });
});
