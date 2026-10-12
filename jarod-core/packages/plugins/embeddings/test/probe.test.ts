/**
 * Sonde numérique à la compilation (Q7) sur un runtime simulé : un périphérique hors CPU n'est retenu que
 * si, sur le jeu de sonde, `1 − cosinus ≤ 1 %` pour chaque texte ET l'ordre des `PROBE_TOP_K` voisins de
 * chaque requête est celui du CPU ; sinon repli journalisé. Sur le vrai NPU : gate P2 (`tests/gates/p2.test.ts`).
 */
import { tempDir } from "@jarod/kernel/testing";
import { cleanup } from "@jarod/kernel/testing";
import { EmbeddingsConfig } from "@jarod/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  COSINE_TOLERANCE,
  cosine,
  type EmbeddingRuntime,
  OpenVinoEmbedder,
  PROBE_DOCS,
  PROBE_QUERIES,
  PROBE_TOP_K,
  topK,
} from "../src/openvino.js";

afterEach(cleanup);

const DIM = 64;

/** Vecteur unitaire déterministe d'un texte (graine = empreinte du texte). */
function vec(text: string, dim = DIM): Float32Array {
  let a = 2166136261;
  for (const c of text) a = Math.imul(a ^ c.charCodeAt(0), 16777619) >>> 0;
  const v = Float32Array.from({ length: dim }, () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  });
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

type Mutate = (text: string, v: Float32Array) => Float32Array;

function fakeRuntime(opts: { mutate?: Record<string, Mutate>; refuse?: string[]; dim?: Record<string, number> } = {}) {
  const compiles: { device: string; maxLength: number }[] = [];
  const calls: { device: string; text: string }[] = [];
  const runtime: EmbeddingRuntime = {
    async compile(_model, device, o) {
      compiles.push({ device, maxLength: o.maxLength });
      if (opts.refuse?.includes(device)) throw new Error(`Exception from plugin.cpp:1\nCompilation failed on ${device}`);
      return async (text) => {
        calls.push({ device, text });
        const v = vec(text, opts.dim?.[device]);
        return opts.mutate?.[device]?.(text, v) ?? v;
      };
    },
    async tokens(_model, text) {
      return text.split(" ").length;
    },
  };
  return { runtime, compiles, calls };
}

/** Bruit déterministe d'amplitude `eps` sur chaque composante (petit écart de calcul, ordre conservé). */
const noise =
  (eps: number): Mutate =>
  (text, v) => {
    const r = vec(`${text}#bruit`);
    return v.map((x, i) => x + eps * r[i]!);
  };

function embedder(runtime: EmbeddingRuntime, extra: EmbeddingsConfig = {}) {
  const log: string[] = [];
  // Formes 4 / 64 tokens : les sondes (≤ 16 mots) passent dans la forme « documents ».
  const cfg = EmbeddingsConfig.parse({ modelDir: tempDir(), queryMaxLength: 4, docMaxLength: 64, ...extra });
  return { e: new OpenVinoEmbedder(cfg as never, (l) => log.push(l), runtime), log };
}

const PROBES = [...PROBE_QUERIES, ...PROBE_DOCS];

describe("embeddings : sonde numérique NPU vs CPU à la compilation (Q7)", () => {
  it("NPU juste (1 − cos < 1 %, mêmes voisins) : retenu, référence CPU compilée pour la sonde seulement", async () => {
    const f = fakeRuntime({ mutate: { NPU: noise(0.002) } });
    const { e, log } = embedder(f.runtime);
    const [v] = await e.embed(["bonjour"]);
    expect(e.metrics().device).toEqual({ "4": "NPU" });
    const [a] = e.metrics().attempts;
    expect(a).toMatchObject({ shape: 4, device: "NPU", ok: true, probe: { topK: 5 } });
    expect(a!.probe!.cosineGap).toBeGreaterThan(0);
    expect(a!.probe!.cosineGap).toBeLessThan(COSINE_TOLERANCE);
    expect(a!.probe!.margin).toBeGreaterThan(0);
    expect(f.compiles).toEqual([
      { device: "NPU", maxLength: 4 },
      { device: "CPU", maxLength: 4 },
    ]);
    // Tout le jeu de sonde passe sur les deux périphériques ; le texte réel sur le NPU seul.
    expect(f.calls.filter((c) => c.device === "CPU").map((c) => c.text)).toEqual(PROBES);
    expect(f.calls.filter((c) => c.device === "NPU").map((c) => c.text)).toEqual([...PROBES, "bonjour"]);
    expect(1 - cosine(v!, vec("bonjour"))).toBeLessThan(COSINE_TOLERANCE);
    expect(log.some((l) => /^forme 4 sur NPU : 1 − cos max \S+ ≤ 0\.01, top-5 identique au CPU sur 4 requêtes \(marge CPU min \S+\)$/.test(l))).toBe(true);
  });

  it("1 − cos > 1 % sur une sonde : refusé, journalisé, repli sur l'iGPU juste — référence CPU réutilisée", async () => {
    const doc = PROBE_DOCS[3]!;
    const skewed: Mutate = (text, v) => (text === doc ? v.map((x, i) => (i < 12 ? -x : x)) : v);
    const f = fakeRuntime({ mutate: { NPU: skewed, "GPU.0": noise(0.001) } });
    const { e } = embedder(f.runtime);
    await e.embed(["bonjour"]);
    const m = e.metrics();
    expect(m.device).toEqual({ "4": "GPU.0" });
    expect(m.attempts).toMatchObject([
      { shape: 4, device: "NPU", ok: false, error: expect.stringMatching(/^1 − cosinus 0\.\d+ > 0\.01 vs CPU \(sonde « Pâte à crêpes/) },
      { shape: 4, device: "GPU.0", ok: true },
    ]);
    expect(f.compiles.filter((c) => c.device === "CPU")).toHaveLength(1);
  });

  it("cosinus dans la tolérance mais voisins inversés : refusé (la parité top-k est exigée en plus)", async () => {
    // Requête 1 déplacée d'un pas minimal vers son 2e voisin, juste assez pour qu'il passe 1er.
    const q = vec(PROBE_QUERIES[0]!);
    const docs = PROBE_DOCS.map((t) => vec(t));
    const [d1, d2] = topK(q, docs, 2).map((i) => docs[i]!);
    const dir = d2!.map((x, i) => x - d1![i]!);
    const gapCpu = cosine(q, d1!) - cosine(q, d2!);
    const step = (1.5 * gapCpu) / dir.reduce((s, x) => s + x * x, 0);
    const moved = q.map((x, i) => x + step * dir[i]!);
    expect(1 - cosine(q, moved)).toBeLessThan(COSINE_TOLERANCE); // le cosinus seul laisserait passer
    const f = fakeRuntime({ mutate: { NPU: (text, v) => (text === PROBE_QUERIES[0] ? moved : v) } });
    const { e } = embedder(f.runtime);
    await e.embed(["x"]);
    expect(e.metrics().attempts[0]).toMatchObject({
      device: "NPU",
      ok: false,
      error: expect.stringMatching(/^top-5 différent du CPU pour la requête sonde 1 : \[/),
    });
    expect(e.metrics().device).toEqual({ "4": "GPU.0" });
  });

  it("NPU et iGPU faux : CPU, sans sonde contre lui-même", async () => {
    const flip: Mutate = (_t, v) => v.map((x) => -x);
    const f = fakeRuntime({ mutate: { NPU: flip, "GPU.0": flip } });
    const { e } = embedder(f.runtime);
    await e.embed(["bonjour"]);
    expect(e.metrics().device).toEqual({ "4": "CPU" });
    expect(e.metrics().attempts.map((a) => [a.device, a.ok])).toEqual([
      ["NPU", false],
      ["GPU.0", false],
      ["CPU", true],
    ]);
    expect(e.metrics().attempts[2]!.probe).toBeUndefined();
  });

  it("les seuils sont ceux de Q7 (1 % sur 1 − cos, top-5) et le jeu de sonde les rend exigibles", () => {
    expect(COSINE_TOLERANCE).toBe(0.01);
    expect(PROBE_TOP_K).toBe(5);
    expect(PROBE_DOCS.length).toBeGreaterThan(PROBE_TOP_K);
    expect(PROBE_QUERIES.length).toBeGreaterThanOrEqual(4);
  });

  it("dimension différente du CPU : refusé", async () => {
    const f = fakeRuntime({ dim: { NPU: 4 } });
    const { e } = embedder(f.runtime);
    await e.embed(["x"]);
    expect(e.metrics().attempts[0]).toMatchObject({ device: "NPU", ok: false, error: `dimension 4 ≠ ${DIM} (CPU)` });
    expect(e.metrics().device).toEqual({ "4": "GPU.0" });
  });

  it("chaque forme (requêtes / documents) a sa propre sonde", async () => {
    const f = fakeRuntime({ mutate: { NPU: noise(0.001) } });
    const { e } = embedder(f.runtime);
    await e.embed(["court", "un texte bien plus long que quatre mots"]);
    expect(e.metrics().device).toEqual({ "4": "NPU", "64": "NPU" });
    expect(f.compiles).toEqual([
      { device: "NPU", maxLength: 4 },
      { device: "CPU", maxLength: 4 },
      { device: "NPU", maxLength: 64 },
      { device: "CPU", maxLength: 64 },
    ]);
  });

  it("référence CPU impossible : le périphérique n'est pas retenu à l'aveugle", async () => {
    const f = fakeRuntime({ refuse: ["CPU"] });
    const { e } = embedder(f.runtime);
    await expect(e.embed(["x"])).rejects.toThrow(/aucun périphérique n'a compilé la forme 4/);
    expect(e.metrics().attempts.map((a) => [a.device, a.ok])).toEqual([
      ["NPU", false],
      ["GPU.0", false],
      ["CPU", false],
    ]);
  });
});
