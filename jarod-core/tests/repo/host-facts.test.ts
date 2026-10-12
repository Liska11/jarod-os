// R3 : faits de machine et trace thermique des rapports de banc. Une sonde en échec reste une ERREUR, jamais un zéro.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ThermalTrace,
  collectHostFacts,
  parseNvidiaSmiCsv,
  probeGpus,
  summarizeThermal,
  type GpuReading,
  type Runner,
  type ThermalSample,
} from "../bench/host-facts.js";

const LINE = "0, NVIDIA RTX 4000 Ada Generation, 596.36, 38, 34, 17521, 20475, 420, 24.90";
const reading = (over: Partial<GpuReading> = {}): GpuReading => ({
  index: 0,
  name: "GPU0",
  driverVersion: "596.36",
  temperatureC: 40,
  utilizationPct: 10,
  memoryUsedMiB: 1000,
  memoryTotalMiB: 20000,
  smClockMHz: 420,
  powerW: 25,
  ...over,
});
const ok = (at: number, r: GpuReading[], probeMs = 0): ThermalSample => ({ at, probeMs, gpus: { ok: true, value: r } });
const fail = (at: number, error = "nvidia-smi : absent"): ThermalSample => ({ at, probeMs: 0, gpus: { ok: false, error } });

describe("parseNvidiaSmiCsv", () => {
  it("lit une ligne complète", () => {
    expect(parseNvidiaSmiCsv(LINE)).toEqual([
      {
        index: 0,
        name: "NVIDIA RTX 4000 Ada Generation",
        driverVersion: "596.36",
        temperatureC: 38,
        utilizationPct: 34,
        memoryUsedMiB: 17521,
        memoryTotalMiB: 20475,
        smClockMHz: 420,
        powerW: 24.9,
      },
    ]);
  });

  it("[N/A] et « Not Supported » deviennent null, jamais 0", () => {
    const [g] = parseNvidiaSmiCsv("1, GPU, 570.1, [N/A], [Not Supported], 10, 20, [N/A], N/A");
    expect(g).toMatchObject({ index: 1, temperatureC: null, utilizationPct: null, smClockMHz: null, powerW: null, memoryUsedMiB: 10 });
  });

  it("plusieurs GPU, fins de ligne Windows", () => {
    expect(parseNvidiaSmiCsv(`${LINE}\r\n1, Autre, 596.36, 50, 0, 1, 2, 300, 10.5\r\n`).map((g) => g.index)).toEqual([0, 1]);
  });

  it("sortie vide, colonnes en trop ou en moins, indice illisible : erreur", () => {
    expect(() => parseNvidiaSmiCsv("")).toThrow(/vide/);
    expect(() => parseNvidiaSmiCsv("0, GPU, 1")).toThrow(/3 colonnes au lieu de 9/);
    expect(() => parseNvidiaSmiCsv("x, GPU, 1, 2, 3, 4, 5, 6, 7")).toThrow(/indice de GPU illisible/);
  });
});

describe("probeGpus / collectHostFacts", () => {
  it("la sonde en échec est une erreur nommée, pas une exception ni un zéro", async () => {
    const run: Runner = async () => {
      throw new Error("nvidia-smi : introuvable");
    };
    expect(await probeGpus(run)).toEqual({ ok: false, error: "nvidia-smi : introuvable" });
  });

  it("passe les arguments attendus à nvidia-smi", async () => {
    const calls: [string, string[]][] = [];
    const run: Runner = async (cmd, args) => (calls.push([cmd, args]), LINE);
    const p = await probeGpus(run);
    expect(p.ok).toBe(true);
    expect(calls[0]![0]).toBe("nvidia-smi");
    expect(calls[0]![1].join(" ")).toMatch(/temperature\.gpu/);
    expect(calls[0]![1]).toContain("--format=csv,noheader,nounits");
  });

  it("rend les faits de la machine, GPU en erreur compris", async () => {
    const f = await collectHostFacts(async () => {
      throw new Error("absent");
    }, () => Date.UTC(2026, 9, 2, 12, 0, 0));
    expect(f.collectedAt).toBe("2026-10-02T12:00:00.000Z");
    expect(f.cpu.logicalCores).toBeGreaterThan(0);
    expect(f.ramBytes).toBeGreaterThan(0);
    expect(f.os.platform).toBeTruthy();
    expect(f.gpus).toEqual({ ok: false, error: "absent" });
  });
});

describe("summarizeThermal", () => {
  it("moyenne pondérée par le temps, extrema, couverture pleine", () => {
    const s = summarizeThermal([ok(0, [reading({ temperatureC: 40 })]), ok(10, [reading({ temperatureC: 50 })])], 20);
    expect(s.gpus[0]!.temperatureC).toEqual({ min: 40, max: 50, timeWeightedMean: 45, coverage: 1, samples: 2 });
    expect(s).toMatchObject({ samples: 2, failedProbes: 0, durationMs: 20, startedAt: 0, endedAt: 20 });
  });

  it("une valeur tenue longtemps pèse plus qu'une valeur brève", () => {
    const s = summarizeThermal([ok(0, [reading({ temperatureC: 40 })]), ok(90, [reading({ temperatureC: 80 })])], 100);
    expect(s.gpus[0]!.temperatureC!.timeWeightedMean).toBeCloseTo((40 * 90 + 80 * 10) / 100, 10);
  });

  it("un échantillon en échec laisse un trou : exclu de la moyenne, couverture < 1, erreur listée", () => {
    const s = summarizeThermal([ok(0, [reading({ temperatureC: 40 })]), fail(10), ok(20, [reading({ temperatureC: 60 })])], 30);
    const t = s.gpus[0]!.temperatureC!;
    expect(t.timeWeightedMean).toBe(50);
    expect(t.coverage).toBeCloseTo(20 / 30, 10);
    expect(t).toMatchObject({ min: 40, max: 60, samples: 2 });
    expect(s.failedProbes).toBe(1);
    expect(s.errors).toEqual(["nvidia-smi : absent"]);
  });

  it("les erreurs identiques ne sont listées qu'une fois, dans l'ordre", () => {
    const s = summarizeThermal([fail(0, "a"), fail(1, "b"), fail(2, "a")], 3);
    expect(s.errors).toEqual(["a", "b"]);
    expect(s.failedProbes).toBe(3);
    expect(s.gpus).toEqual([]);
  });

  it("température N/A : pas d'extrema (null), jamais 0", () => {
    const s = summarizeThermal([ok(0, [reading({ temperatureC: null })])], 10);
    expect(s.gpus[0]!.temperatureC).toBeNull();
    expect(s.gpus[0]!.powerW).not.toBeNull();
  });

  it("aucun échantillon : tout est vide", () => {
    expect(summarizeThermal([], 100)).toEqual({
      startedAt: null,
      endedAt: null,
      durationMs: 0,
      samples: 0,
      failedProbes: 0,
      errors: [],
      probeMsTotal: 0,
      gpus: [],
    });
  });

  it("un seul instant : la valeur elle-même, couverture 1", () => {
    const s = summarizeThermal([ok(5, [reading({ temperatureC: 47 })])], 5);
    expect(s.gpus[0]!.temperatureC).toEqual({ min: 47, max: 47, timeWeightedMean: 47, coverage: 1, samples: 1 });
  });

  it("deux GPU suivis séparément, triés par indice ; les échantillons arrivés en désordre sont remis dans l'ordre", () => {
    const g = (index: number, t: number) => reading({ index, name: `G${index}`, temperatureC: t });
    const s = summarizeThermal([ok(10, [g(1, 70), g(0, 50)]), ok(0, [g(1, 60), g(0, 40)])], 20);
    expect(s.gpus.map((x) => [x.index, x.name, x.temperatureC!.timeWeightedMean])).toEqual([
      [0, "G0", 45],
      [1, "G1", 65],
    ]);
  });

  it("la durée des sondes est cumulée, jamais soustraite", () => {
    expect(summarizeThermal([ok(0, [reading()], 80), ok(10, [reading()], 120)], 20).probeMsTotal).toBe(200);
  });
});

describe("ThermalTrace", () => {
  afterEach(() => vi.useRealTimers());

  it("sample() avant, stop() après : deux échantillons au moins, durée de sonde relevée", async () => {
    let t = 1000;
    const trace = new ThermalTrace(async () => ((t += 30), LINE), () => t);
    await trace.sample();
    t += 5000;
    const { summary, samples } = await trace.stop();
    expect(samples.length).toBe(2);
    expect(samples[0]!.probeMs).toBe(30);
    expect(summary.failedProbes).toBe(0);
    expect(summary.gpus[0]!.temperatureC!.min).toBe(38);
  });

  it("l'échantillonnage périodique ne s'empile pas : un tour en retard est sauté", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release!: () => void;
    const slow: Runner = () => {
      calls++;
      return new Promise<string>((r) => (release = () => r(LINE)));
    };
    const trace = new ThermalTrace(slow);
    trace.start(500);
    await vi.advanceTimersByTimeAsync(2600); // 5 tours, mais la première sonde ne finit jamais
    expect(calls).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    const fast = new ThermalTrace(async () => LINE);
    fast.start(500);
    await vi.advanceTimersByTimeAsync(1600);
    const { samples } = await fast.stop();
    expect(samples.length).toBeGreaterThanOrEqual(4); // 3 périodiques + l'échantillon final
  });

  it("refuse un intervalle sous 250 ms et un double démarrage", () => {
    const trace = new ThermalTrace(async () => LINE);
    expect(() => trace.start(100)).toThrow(/250 ms/);
    trace.start(1000);
    expect(() => trace.start(1000)).toThrow(/déjà démarrée/);
    clearInterval((trace as unknown as { timer: ReturnType<typeof setInterval> }).timer);
  });

  it("une sonde en échec pendant la trace est comptée, la trace continue", async () => {
    const trace = new ThermalTrace(async () => {
      throw new Error("nvidia-smi : délai dépassé");
    });
    await trace.sample();
    const { summary } = await trace.stop();
    expect(summary.failedProbes).toBe(2);
    expect(summary.errors).toEqual(["nvidia-smi : délai dépassé"]);
    expect(summary.gpus).toEqual([]);
  });
});
