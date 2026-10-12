/**
 * W10 — banc du mot d'activation sur le VRAI NPU (PLAN §5.3) : `ctx.voice.listen` (kernel réel,
 * plugin-voice configuré) sur de l'audio synthétisé localement par SAPI en 16 kHz mono :
 *   positif : la phrase d'activation, entourée de silence → exactement UNE détection (`voice:wake`) ;
 *   négatifs : phrases ordinaires FR/EN → aucune détection.
 * Puis mêmes flux sur CPU seul : écart des scores NPU/CPU (le NPU calcule en FP16) et latence par bloc.
 * Embedding et classifieur doivent tourner sur le NPU ; le mel va où la sonde numérique l'accepte.
 * Modèles openWakeWord : mel + embedding dans `.work/wakeword/` ; classifieur par défaut = B7/B8
 * `hey_jarvis_v0.1.onnx` dans `S:\Stack-Hermes\IA\models\wakeword\` (release officielle v0.5.1),
 * chargé sous sa forme `.where.onnx` (`scripts/onnx_if_to_where.py` : le `If` du vérificateur, refusé par
 * le frontal ONNX d'OpenVINO, devient un `Where` — sorties identiques sous onnxruntime) ; empreintes
 * SHA-256 des deux fichiers vérifiées ci-dessous. Sinon `hey_hermes.tflite` (modèle local) ; surchargeable :
 * JAROD_WAKEWORD_DIR, JAROD_WAKEWORD_MODEL, JAROD_WAKEWORD_PHRASE. Lancement : `pnpm --filter @jarod/gates bench:wakeword`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { readWavPcm16, type VoiceService, WakeWordDetector } from "@jarod/plugin-voice";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WW = join(ROOT, ".work", "wakeword");
const MODELS = process.env.JAROD_WAKEWORD_DIR ?? "S:/Stack-Hermes/IA/models/wakeword";
/** B8 : release officielle openWakeWord v0.5.1 (1 271 370 o). */
const JARVIS_URL = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/hey_jarvis_v0.1.onnx";
const JARVIS = join(MODELS, "hey_jarvis_v0.1.onnx");
const JARVIS_SHA256 = "94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb";
/** `python scripts/onnx_if_to_where.py hey_jarvis_v0.1.onnx hey_jarvis_v0.1.where.onnx` (déterministe). */
const JARVIS_OV = join(MODELS, "hey_jarvis_v0.1.where.onnx");
const JARVIS_OV_SHA256 = "4e10fc5c243efac0a4451ce4ec2ad05cf8393bdacccc0e52d7870329019eb212";
const MODEL = process.env.JAROD_WAKEWORD_MODEL ?? (existsSync(JARVIS_OV) ? JARVIS_OV : join(WW, "hey_hermes.tflite"));
const WORD = basename(MODEL).replace(/(_v[\d.]+?)?(\.where)?\.(onnx|tflite)$/, "");
const PHRASE = process.env.JAROD_WAKEWORD_PHRASE ?? (WORD === "hey_jarvis" ? "Hey Jarvis" : "Hey Hermes");
const NEGATIVES: [string, string][] = [
  ["Microsoft Hortense Desktop", "Bonjour Jarod, rappelle-moi d'acheter du pain demain matin à huit heures."],
  ["Microsoft Zira Desktop", "Hello there, what time is it in Paris right now?"],
  ["Microsoft Zira Desktop", "Please send the report to Henry before the meeting."],
];

const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[bench-wakeword] ${l}`);
};

/** SAPI → WAV 16 kHz mono 16 bits, avec 1 s de silence avant et après. */
function say(voice: string, text: string, file: string): Int16Array {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('${voice}'); $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${file}', $f); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`,
    ],
    { input: text, windowsHide: true, timeout: 60_000 },
  );
  const { sampleRate, pcm } = readWavPcm16(readFileSync(file));
  expect(sampleRate).toBe(16000);
  const out = new Int16Array(pcm.length + 32000);
  out.set(pcm, 16000);
  return out;
}

describe("W10 — mot d'activation openWakeWord sur NPU", () => {
  it(`« ${PHRASE} » détecté une fois, phrases ordinaires ignorées ; NPU ≈ CPU`, { timeout: 300_000 }, async () => {
    const cfg = { melModel: join(WW, "melspectrogram.onnx"), embeddingModel: join(WW, "embedding_model.onnx"), models: { [WORD]: MODEL } };
    for (const f of [cfg.melModel, cfg.embeddingModel, MODEL]) expect(existsSync(f), `absent : ${f}`).toBe(true);
    mkdirSync(join(WW, "audio"), { recursive: true });
    const positive = say("Microsoft Zira Desktop", PHRASE, join(WW, "audio", "positive.wav"));
    const negatives = NEGATIVES.map(([v, t], i) => ({ text: t, pcm: say(v, t, join(WW, "audio", `negative-${i}.wav`)) }));
    const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    log(`mot « ${WORD} » (${MODEL}, sha256 ${sha(MODEL)}), phrase « ${PHRASE} » : ${positive.length} échantillons`);
    if (MODEL === JARVIS_OV) {
      log(`  source : ${JARVIS} (sha256 ${sha(JARVIS)}), openWakeWord v0.5.1, release officielle : ${JARVIS_URL}`);
      log("  licences : code Apache-2.0, modèles pré-entraînés CC BY-NC-SA 4.0 (README v0.5.1, § License)");
      expect(sha(JARVIS)).toBe(JARVIS_SHA256);
      expect(sha(JARVIS_OV)).toBe(JARVIS_OV_SHA256);
    }

    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: join(WW, `profil-${Date.now()}`), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.agent = { runtimeLock: false, curatorTimer: false };
    plugins.mcp = { autoSync: false };
    plugins.voice = { wakeword: { ...cfg, warmup: true } };
    const app = new JarodApp({ plugins });
    const t0 = Date.now();
    const started = await start(app);
    const voice = (app as unknown as { voice: VoiceService }).voice;
    const events: unknown[] = [];
    (app as unknown as { on(e: string, cb: (d: unknown) => void): void }).on("voice:wake", (d) => events.push(d));
    try {
      const m0 = voice.wakeword!.metrics();
      log(`compilation (démarrage du kernel compris) ${Date.now() - t0} ms ; périphériques ${JSON.stringify(m0.devices)}`);
      for (const a of m0.attempts) log(`  ${a.model} → ${a.device} ${a.ok ? "OK" : `refusé (${a.error})`} ${a.ms} ms`);
      // Embedding (le gros du calcul) et classifieur sur le NPU ; le mel là où il calcule juste (sonde vs CPU).
      expect(m0.devices.embedding).toBe("NPU");
      expect(m0.devices[WORD]).toBe("NPU");

      // Flux « micro » : blocs de 20 ms (320 échantillons), comme un AudioWorklet.
      const feed = async (pcm: Int16Array) => {
        voice.wakeword!.reset();
        const hits = [];
        let max = 0;
        for (let i = 0; i < pcm.length; i += 320) {
          const before = voice.wakeword!.metrics().chunks;
          hits.push(...(await voice.listen(pcm.subarray(i, i + 320))));
          void before;
        }
        return { hits, max };
      };
      const scoresOf = async (d: WakeWordDetector, pcm: Int16Array) => {
        d.reset();
        return (await d.process(pcm)).scores.map((s) => s[WORD] ?? 0);
      };

      const pos = await feed(positive);
      const posScores = await scoresOf(voice.wakeword!, positive);
      log(`positif : ${pos.hits.length} détection(s) ${JSON.stringify(pos.hits.map((h) => ({ at: h.atMs, score: +h.score.toFixed(3) })))} ; score max ${Math.max(...posScores).toFixed(3)}`);
      expect(pos.hits).toHaveLength(1);
      expect(events).toHaveLength(1);

      for (const n of negatives) {
        const hits = (await feed(n.pcm)).hits;
        const s = await scoresOf(voice.wakeword!, n.pcm);
        log(`négatif « ${n.text} » : ${hits.length} détection(s), score max ${Math.max(...s).toFixed(3)}`);
        expect(hits).toHaveLength(0);
      }
      const m = voice.wakeword!.metrics();
      log(`latence par bloc de 80 ms (NPU) : p50 ${m.p50Ms?.toFixed(2)} ms, p95 ${m.p95Ms?.toFixed(2)} ms sur ${m.chunks} blocs`);

      // Même flux sur CPU : écart dû au FP16 du NPU.
      const cpu = new WakeWordDetector({ ...cfg, devices: ["CPU"] });
      const cpuScores = await scoresOf(cpu, positive);
      const diff = Math.max(...posScores.map((v, i) => Math.abs(v - (cpuScores[i] ?? 0))));
      log(`écart max des scores NPU/CPU sur le positif : ${diff.toFixed(4)} (CPU max ${Math.max(...cpuScores).toFixed(3)})`);
      expect(diff).toBeLessThan(0.1);
    } finally {
      await stop(started);
      writeFileSync(join(WW, `report-${Date.now()}.txt`), `${report.join("\n")}\n`);
    }
  });
});
