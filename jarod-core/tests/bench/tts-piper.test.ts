/**
 * W4 — banc TTS Piper (PLAN §4.3) : `ctx.voice.speech` (kernel réel, plugin-voice configuré avec Piper)
 * synthétise une phrase française en WAV sur CPU, puis `ctx.voice.transcribe` la relit par whisper.cpp
 * (Vulkan, iGPU) — la chaîne de la gate P3 dictée, avec la voix Piper au lieu de SAPI. Même métrique
 * (`gates/recall.ts`) et même seuil de rappel (80 %) que la gate. Aucun son n'est joué, aucune clé.
 * Piper et sa voix sont lus en place (lecture seule) : JAROD_PIPER_BIN / JAROD_PIPER_MODEL.
 * Lancement : `pnpm --filter @jarod/gates bench:tts`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { describe, expect, it } from "vitest";
import { recall } from "../gates/recall.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = join(ROOT, ".work", "tts");
const WHISPER = join(ROOT, ".work", "whisper.cpp", "build", "bin", "Release", "whisper-server.exe");
const WHISPER_MODEL = join(ROOT, ".work", "models", "ggml-large-v3-turbo-q5_0.bin");
const PIPER_BIN = process.env.JAROD_PIPER_BIN ?? "S:/Stack-Hermes/IA/npu-sidecar-venv/Scripts/piper.exe";
const PIPER_MODEL = process.env.JAROD_PIPER_MODEL ?? "S:/Stack-Hermes/IA/models/kama-flow/piper-fr/model.onnx";
const VOICE = "piper:fr_FR-siwis-medium";
const PHRASE = "Bonjour Jarod, rappelle-moi d'acheter du pain demain matin à huit heures.";

const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[bench-tts] ${l}`);
};

const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });

describe("W4 — TTS Piper local → whisper.cpp", () => {
  it("Piper (CPU) synthétise, whisper (iGPU) relit la phrase", { timeout: 300_000 }, async () => {
    for (const f of [PIPER_BIN, PIPER_MODEL, `${PIPER_MODEL}.json`, WHISPER, WHISPER_MODEL]) expect(existsSync(f), `absent : ${f}`).toBe(true);
    mkdirSync(WORK, { recursive: true });
    const port = await freePort();
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: join(WORK, `profil-${Date.now()}`), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.agent = { runtimeLock: false, curatorTimer: false };
    plugins.mcp = { autoSync: false };
    plugins.voice = {
      whisper: { bin: WHISPER, model: WHISPER_MODEL, port, language: "fr", device: 1, convert: true },
      piper: { bin: PIPER_BIN, voices: { "fr_FR-siwis-medium": PIPER_MODEL } },
    };
    const app = new JarodApp({ plugins });
    const started = await start(app);
    const k = app as unknown as {
      storage: { settings: import("@jarod/plugin-storage").SettingsService };
      voice: import("@jarod/plugin-voice").VoiceService;
    };
    try {
      const voices = await k.voice.speech.voices();
      log(`voix : ${voices.join(" | ")}`);
      expect(voices).toContain(VOICE);

      const wav = join(WORK, "piper.wav");
      let t0 = Date.now();
      const r = await k.voice.speech.synthesizePiper(PHRASE, { voice: VOICE }, wav);
      const size = readFileSync(wav).length;
      log(`Piper : ${r.chars} caractères → ${size} o WAV en ${Date.now() - t0} ms`);
      expect(readFileSync(wav).subarray(0, 4).toString("latin1")).toBe("RIFF");

      const s = k.storage.settings;
      s.set("voice", { ...s.get("voice"), sttProvider: "local-whisper-cpp", sttModel: "" });
      s.set("providerOverrides", { "local-whisper-cpp": { baseUrl: `http://127.0.0.1:${port}/v1` } });
      expect(s.secretKeys()).toEqual([]);
      await k.voice.startWhisper();
      t0 = Date.now();
      const text = await k.voice.transcribe(readFileSync(wav), "audio/wav");
      const score = recall(PHRASE, text);
      log(`whisper → « ${text} » en ${Date.now() - t0} ms, rappel des mots ${(score * 100).toFixed(0)} %`);
      expect(score).toBeGreaterThanOrEqual(0.8);
    } finally {
      await stop(started);
      writeFileSync(join(WORK, `report-${Date.now()}.txt`), `${report.join("\n")}\n`);
    }
  });
});
