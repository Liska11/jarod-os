/**
 * GATE P3 — volet 1 : « dictée locale sans clé API » (PLAN §6, gap G3, §4).
 *
 * Chaîne réelle, 100 % locale : une phrase française est SYNTHÉTISÉE par la voix Windows (SAPI,
 * Hortense), enregistrée en WAV puis en WebM/Opus (format du micro du desktop), et TRANSCRITE par
 * `ctx.voice.transcribe` → fournisseur `local-whisper-cpp` → whisper-server (whisper.cpp compilé
 * Vulkan) sur l'iGPU Intel, modèle large-v3-turbo q5_0. Aucune clé, aucun réseau hors 127.0.0.1.
 *
 * `pnpm gate:p3-voice` ; volet 2 (Telegram vivant, opt-in `GATE_TELEGRAM_LIVE=1`) : `pnpm gate:p3-telegram`.
 * `pnpm gate:p3` = les deux, dans cet ordre.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { describe, expect, it } from "vitest";
import { recall } from "./recall.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORK = join(ROOT, ".work", "gate-p3");
const BIN = join(ROOT, ".work", "whisper.cpp", "build", "bin", "Release", "whisper-server.exe");
const MODEL = join(ROOT, ".work", "models", "ggml-large-v3-turbo-q5_0.bin");
const PHRASE = "Bonjour Jarod, rappelle-moi d'acheter du pain demain matin à huit heures.";

const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[gate-p3] ${l}`);
};

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });
}

describe("GATE P3 — dictée locale sans clé API", () => {
  it("TTS local → WAV/WebM → whisper.cpp Vulkan sur iGPU → texte", { timeout: 600_000 }, async () => {
    expect(existsSync(BIN), `whisper-server absent : ${BIN}`).toBe(true);
    expect(existsSync(MODEL), `modèle absent : ${MODEL}`).toBe(true);
    mkdirSync(WORK, { recursive: true });
    const wav = join(WORK, "dictee.wav");
    const webm = join(WORK, "dictee.webm");
    // Voix locale Windows : aucune clé, aucun réseau.
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Hortense Desktop'); $s.SetOutputToWaveFile('${wav}'); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`,
      ],
      { input: PHRASE, windowsHide: true, timeout: 60_000 },
    );
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", webm], { timeout: 60_000 });
    log(`audio : ${readFileSync(wav).length} o WAV, ${readFileSync(webm).length} o WebM/Opus — « ${PHRASE} »`);

    const port = await freePort();
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: join(WORK, `profil-${Date.now()}`), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.agent = { runtimeLock: false, curatorTimer: false };
    plugins.mcp = { autoSync: false };
    plugins.voice = { whisper: { bin: BIN, model: MODEL, port, language: "fr", device: 1, convert: true } };
    const app = new JarodApp({ plugins });
    const started = await start(app);
    const k = app as unknown as {
      storage: { settings: import("@jarod/plugin-storage").SettingsService };
      voice: import("@jarod/plugin-voice").VoiceService;
    };
    try {
      const s = k.storage.settings;
      s.set("voice", { ...s.get("voice"), sttProvider: "local-whisper-cpp", sttModel: "" });
      s.set("providerOverrides", { "local-whisper-cpp": { baseUrl: `http://127.0.0.1:${port}/v1` } });
      expect(s.secretKeys()).toEqual([]); // aucune clé dans le profil

      let t0 = Date.now();
      const st = await k.voice.startWhisper();
      log(`whisper-server prêt en ${Date.now() - t0} ms (pid ${st.pid}, port ${port}, Vulkan ${st.device})`);
      const gpuLines = k.voice.whisperLog().filter((l) => /vulkan/i.test(l));
      for (const l of gpuLines.slice(0, 6)) log(`  ${l}`);
      expect(gpuLines.some((l) => /Intel/.test(l))).toBe(true);
      expect(k.voice.whisperLog().some((l) => /using Vulkan1 backend/.test(l))).toBe(true);

      for (const [file, mime] of [
        [wav, "audio/wav"],
        [webm, "audio/webm"],
      ] as const) {
        t0 = Date.now();
        const text = await k.voice.transcribe(readFileSync(file), mime);
        const r = recall(PHRASE, text);
        log(`${mime} → « ${text} » en ${Date.now() - t0} ms, rappel des mots ${(r * 100).toFixed(0)} %`);
        expect(r).toBeGreaterThanOrEqual(0.8);
      }
    } finally {
      await stop(started);
      writeFileSync(join(WORK, `report-${Date.now()}.txt`), `${report.join("\n")}\n`);
    }
  });
});
