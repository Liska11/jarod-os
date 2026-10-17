// C1 contre silero-vad v5.1.2 (modèle ONNX réel via onnxruntime) sur de la parole synthétisée (SAPI) ; C2 contre sherpa-onnx.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_VAD, segmentSpeech } from "../../src/index.js";
import { HAS_PY, PY, ROOT, SIDECARS, readWavPcm16, synthSpeech } from "./helpers.js";

const MODEL = join(ROOT, "engines", "models", "silero", "silero_vad.onnx");
const MODEL_SHA256 = "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f";
const dir = mkdtempSync(join(tmpdir(), "jarod-speech-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function score(pcm: Float32Array): number[] {
  const raw = join(dir, `${createHash("md5").update(Buffer.from(pcm.buffer)).digest("hex")}.raw`);
  writeFileSync(raw, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return JSON.parse(execFileSync(PY, [join(SIDECARS, "silero-vad", "score.py"), MODEL, raw], { encoding: "utf8", timeout: 120_000 })) as number[];
}

/** Les probabilités réelles du modèle, rendues à `segmentSpeech` par indice de trame. */
const scorerOf = (probs: number[]) => {
  let i = 0;
  return () => probs[i++] ?? 0;
};

describe.skipIf(!HAS_PY || !existsSync(MODEL))("C1 contre silero-vad (modèle ONNX réel)", () => {
  it("les poids sont ceux qui ont été épinglés", () => {
    expect(createHash("sha256").update(readFileSync(MODEL)).digest("hex")).toBe(MODEL_SHA256);
  });

  it("détecte la parole réelle entourée de silence : un segment, dans la bonne zone", () => {
    const wav = join(dir, "speech.wav");
    synthSpeech("Bonjour, ceci est un test de détection de la voix.", wav);
    const speech = readWavPcm16(wav);
    const pad = new Float32Array(16000); // 1 s de silence de chaque côté
    const pcm = new Float32Array(pad.length * 2 + speech.length);
    pcm.set(speech, pad.length);
    const probs = score(pcm);
    const frames = Array.from({ length: probs.length }, () => new Float32Array(512));
    const segs = segmentSpeech(frames, scorerOf(probs), DEFAULT_VAD);
    expect(segs.length).toBeGreaterThanOrEqual(1);
    const firstMs = (segs[0]!.startFrame * 512 * 1000) / 16000;
    const lastMs = (segs.at(-1)!.endFrame * 512 * 1000) / 16000;
    expect(firstMs).toBeGreaterThan(700); // pas avant la fin du silence initial
    expect(lastMs).toBeLessThan(1000 + (speech.length / 16) + 1000); // pas bien après la fin de la parole
    const speechMs = speech.length / 16;
    const covered = segs.reduce((n, s) => n + ((s.endFrame - s.startFrame) * 512) / 16, 0);
    expect(covered).toBeGreaterThan(speechMs * 0.6);
  }, 180_000);

  it("ne détecte rien dans du silence ni dans un bruit blanc faible", () => {
    const silence = new Float32Array(16000 * 3);
    const noise = Float32Array.from({ length: 16000 * 3 }, () => (Math.random() - 0.5) * 0.02);
    for (const pcm of [silence, noise]) {
      const probs = score(pcm);
      const frames = Array.from({ length: probs.length }, () => new Float32Array(512));
      expect(segmentSpeech(frames, scorerOf(probs), DEFAULT_VAD)).toEqual([]);
    }
  }, 180_000);
});

// ------------------------------------------------------------------ C2

import { spawnSync } from "node:child_process";
import { LocalStt, type SttEngine } from "../../src/index.js";

const SHERPA_MODEL = join(ROOT, "engines", "models", "sherpa", "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17");

function sherpaEngine(): SttEngine {
  return {
    locality: "local",
    async transcribe(pcm, sampleRate) {
      const raw = join(dir, `stt-${Math.random().toString(36).slice(2)}.raw`);
      writeFileSync(raw, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      const r = spawnSync(PY, [join(SIDECARS, "sherpa-stt", "transcribe.py"), SHERPA_MODEL, raw, String(sampleRate)], { encoding: "utf8", timeout: 180_000 });
      if (r.status !== 0) throw new Error(`sherpa a échoué : ${r.stderr.slice(-200)}`);
      const text = (JSON.parse(r.stdout) as { text: string }).text;
      // sherpa-onnx ne rend pas de confiance : un texte non vide vaut 1, un texte vide 0.
      return { text, confidence: text ? 1 : 0 };
    },
  };
}

describe.skipIf(!HAS_PY || !existsSync(SHERPA_MODEL))("C2 contre sherpa-onnx (modèle zipformer réel, hors ligne)", () => {
  it("transcrit de la parole synthétisée (voix anglaise de la machine)", async () => {
    const wav = join(dir, "en.wav");
    synthSpeech("Hello world. This is a test of local speech recognition.", wav, "Microsoft Zira Desktop");
    const speech = readWavPcm16(wav);
    const pcm = new Float32Array(8000 + speech.length); // 0,5 s de silence devant : le synthétiseur coupe le début de la première syllabe
    pcm.set(speech, 8000);
    const text = (await new LocalStt(sherpaEngine()).transcribe(pcm, 16000)).toLowerCase();
    expect(text).toContain("world");
    expect(text).toContain("test");
    expect(text).toContain("speech recognition");
  }, 300_000);

  it("du silence donne un texte vide, et un moteur distant reste refusé", async () => {
    expect(await new LocalStt(sherpaEngine()).transcribe(new Float32Array(16000 * 2), 16000)).toBe("");
    await expect(new LocalStt({ ...sherpaEngine(), locality: "remote" }).transcribe(new Float32Array(1600), 16000)).rejects.toThrow(/ne quitte pas/);
  }, 300_000);
});
