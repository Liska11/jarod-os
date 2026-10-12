/**
 * W10 — détecteur openWakeWord (`wakeword.ts`) sur un runtime OpenVINO simulé : découpage en blocs de
 * 80 ms, contexte mel reporté, transformée `x/10 + 2`, fenêtres 76 → 96 → 16, seuil, anti-rebond,
 * repli NPU → GPU → CPU journalisé. Les vrais modèles sur le vrai NPU : `tests/bench/wakeword-npu.test.ts`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { readWavPcm16, type WakeWordConfig, WakeWordDetector, type WakeWordRuntime } from "../src/wakeword.js";

afterEach(cleanup);

function files() {
  const dir = tempDir();
  const f = (n: string) => {
    const p = join(dir, n);
    writeFileSync(p, "");
    return p;
  };
  return { melModel: f("mel.onnx"), embeddingModel: f("emb.onnx"), models: { hey_jarvis: f("hey_jarvis.onnx") } };
}

function fakeRuntime(opts: { refuse?: string[]; score?: (call: number) => number; skewMelOn?: string } = {}) {
  const calls: { model: string; shape: number[]; device: string }[] = [];
  const inputs: Record<string, Float32Array[]> = { mel: [], emb: [], word: [] };
  let wordCalls = 0;
  /** Le score scénarisé ne joue qu'après la compilation (sinon la sonde numérique le verrait diverger du CPU). */
  let armed = false;
  const runtime: WakeWordRuntime = {
    async compile(path, shape, device) {
      calls.push({ model: path.split(/[\\/]/).pop()!, shape, device });
      if (opts.refuse?.includes(device)) throw new Error(`Exception from plugin.cpp:1\nCompilation failed on ${device}`);
      if (path.endsWith("mel.onnx")) return async (x) => (inputs.mel!.push(x), new Float32Array(8 * 32).fill(device === opts.skewMelOn ? 4 : 10));
      if (path.endsWith("emb.onnx")) return async (x) => (inputs.emb!.push(x), new Float32Array(96).fill(0.5));
      return async (x) => (inputs.word!.push(x), Float32Array.of(armed && opts.score ? opts.score(wordCalls++) : 0.1));
    },
  };
  /** Compile tout (sondes numériques comprises), puis oublie ce que les sondes ont fait passer. */
  const ready = async (d: WakeWordDetector) => {
    await d.warmup();
    for (const k of Object.keys(inputs)) inputs[k] = [];
    wordCalls = 0;
    armed = true;
  };
  return { runtime, calls, inputs, ready };
}

const pcm = (n: number, v = 100) => new Int16Array(n).fill(v);

describe("wakeword — pipeline openWakeWord", () => {
  it("compile chaque modèle en forme statique ; repli NPU → GPU journalisé", async () => {
    const cfg: WakeWordConfig = files();
    const rt = fakeRuntime({ refuse: ["NPU"] });
    const d = new WakeWordDetector(cfg, rt.runtime);
    await d.warmup();
    expect(rt.calls.filter((c) => c.device === "GPU.0").map((c) => [c.model, c.shape])).toEqual([
      ["mel.onnx", [1, 1760]],
      ["emb.onnx", [1, 76, 32, 1]],
      ["hey_jarvis.onnx", [1, 16, 96]],
    ]);
    const m = d.metrics();
    expect(m.devices).toEqual({ mel: "GPU.0", embedding: "GPU.0", hey_jarvis: "GPU.0" });
    expect(m.attempts.filter((a) => !a.ok).map((a) => [a.model, a.device, a.error])).toEqual([
      ["mel", "NPU", "Compilation failed on NPU"],
      ["embedding", "NPU", "Compilation failed on NPU"],
      ["hey_jarvis", "NPU", "Compilation failed on NPU"],
    ]);
  });

  it("compile mais calcule faux (écart > 1 % du CPU sur la sonde) : périphérique refusé, repli journalisé", async () => {
    const rt = fakeRuntime({ skewMelOn: "NPU" });
    const d = new WakeWordDetector(files(), rt.runtime);
    await d.warmup();
    const m = d.metrics();
    expect(m.devices).toEqual({ mel: "GPU.0", embedding: "NPU", hey_jarvis: "NPU" });
    expect(m.attempts.find((a) => a.model === "mel" && a.device === "NPU")!.error).toMatch(/écart numérique 6\.00 > 0\.100/);
  });

  it("aucun périphérique, modèle absent, aucun mot : erreurs nommées", async () => {
    const all = fakeRuntime({ refuse: ["NPU", "GPU.0", "CPU"] });
    await expect(new WakeWordDetector(files(), all.runtime).warmup()).rejects.toThrow(/WAKEWORD_NO_DEVICE: .*mel/);
    const missing = { ...files(), melModel: "C:/nulle-part/mel.onnx" };
    await expect(new WakeWordDetector(missing, fakeRuntime().runtime).warmup()).rejects.toThrow(/WAKEWORD_NO_MODEL: .*mel/);
    expect(() => new WakeWordDetector({ ...files(), models: {} }, fakeRuntime().runtime)).toThrow(/WAKEWORD_NO_MODEL/);
  });

  it("blocs de 1280 échantillons, reste gardé ; contexte mel de 480 reporté ; transformée x/10+2", async () => {
    const rt = fakeRuntime();
    const d = new WakeWordDetector(files(), rt.runtime);
    await rt.ready(d);
    let r = await d.process(pcm(1000, 1));
    expect(r.scores).toEqual([]); // < 80 ms : rien de traité
    r = await d.process(pcm(1560, 2)); // 2560 en tout = 2 blocs
    expect(r.scores).toHaveLength(2);
    const [first, second] = rt.inputs.mel as [Float32Array, Float32Array];
    expect(first.length).toBe(1760);
    expect([...first.subarray(0, 480)].every((v) => v === 0)).toBe(true); // contexte initial = zéros
    expect(first[480]).toBe(1);
    expect([...second.subarray(0, 480)]).toEqual([...first.subarray(1760 - 480)]); // contexte reporté
    // Mel constant 10 → trames transformées 10/10+2 = 3 dans la fenêtre d'embedding (après les 76 « 1 » initiaux).
    const emb = rt.inputs.emb!.at(-1)!;
    expect(emb.length).toBe(76 * 32);
    expect(emb.at(-1)).toBe(3);
    expect(emb[0]).toBe(1);
  });

  it("pas de score avant 16 vecteurs réels ; puis classifieur sur les 16 derniers", async () => {
    const rt = fakeRuntime();
    const d = new WakeWordDetector(files(), rt.runtime);
    await rt.ready(d);
    const r = await d.process(pcm(1280 * 17));
    expect(r.scores.slice(0, 15).every((s) => s.hey_jarvis === 0)).toBe(true);
    expect(rt.inputs.word).toHaveLength(2); // blocs 16 et 17
    expect(rt.inputs.word![0]!.length).toBe(16 * 96);
    expect(r.scores[15]!.hey_jarvis).toBeCloseTo(0.1);
  });

  it("seuil et anti-rebond : un mot prononcé = une détection", async () => {
    // Score 0,9 sur les appels 0-4 (≈ 400 ms de mot), puis 0,1, puis de nouveau 0,9 à l'appel 40.
    const rt = fakeRuntime({ score: (n) => (n < 5 || n === 40 ? 0.9 : 0.1) });
    const d = new WakeWordDetector({ ...files(), debounceMs: 1500 }, rt.runtime);
    await rt.ready(d);
    const r = await d.process(pcm(1280 * 70));
    expect(r.detections.map((x) => [x.model, x.atMs])).toEqual([
      ["hey_jarvis", 16 * 80],
      ["hey_jarvis", (16 + 40) * 80],
    ]);
    d.reset();
    expect((await d.process(pcm(1280 * 3))).scores.every((s) => s.hey_jarvis === 0)).toBe(true);
  });

  it("appels concurrents sérialisés (un NPU ne se partage pas) ; métriques", async () => {
    const d = new WakeWordDetector(files(), fakeRuntime().runtime);
    const [a, b] = await Promise.all([d.process(pcm(1280 * 2)), d.process(pcm(1280 * 3))]);
    expect(a.scores).toHaveLength(2);
    expect(b.scores).toHaveLength(3);
    const m = d.metrics();
    expect(m.chunks).toBe(5);
    expect(m.p95Ms).not.toBeNull();
    expect(m.lastError).toBeNull();
  });
});

describe("wakeword — lecture WAV", () => {
  it("PCM 16 bits mono et son débit ; stéréo refusé", () => {
    const wav = (channels: number, rate: number, samples: number[]) => {
      const data = Buffer.alloc(samples.length * 2);
      samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
      const h = Buffer.alloc(44);
      h.write("RIFF", 0, "latin1");
      h.writeUInt32LE(36 + data.length, 4);
      h.write("WAVEfmt ", 8, "latin1");
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(channels, 22);
      h.writeUInt32LE(rate, 24);
      h.writeUInt32LE(rate * channels * 2, 28);
      h.writeUInt16LE(channels * 2, 32);
      h.writeUInt16LE(16, 34);
      h.write("data", 36, "latin1");
      h.writeUInt32LE(data.length, 40);
      return Buffer.concat([h, data]);
    };
    const r = readWavPcm16(wav(1, 16000, [1, -2, 32767]));
    expect(r.sampleRate).toBe(16000);
    expect([...r.pcm]).toEqual([1, -2, 32767]);
    expect(() => readWavPcm16(wav(2, 16000, [1, 2]))).toThrow(/mono 16 bits/);
    expect(() => readWavPcm16(Buffer.from("pas un wav"))).toThrow(/WAV invalide/);
  });
});
