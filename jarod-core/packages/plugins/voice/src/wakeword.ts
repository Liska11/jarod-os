/**
 * Mot d'activation toujours à l'écoute sur le NPU (PLAN §5.3, W10) : le pipeline openWakeWord
 * (Apache-2.0, github.com/dscripka/openWakeWord, `openwakeword/utils.py` `AudioFeatures` et
 * `model.py` `predict`, v0.6.0) réécrit en TypeScript sur OpenVINO (`openvino-node`), sans Python :
 *
 *   PCM 16 kHz int16, blocs de 1280 échantillons (80 ms)
 *   → melspectrogram.onnx sur [480 échantillons de contexte + 1280] = 8 trames × 32, transformées `x/10 + 2`
 *   → embedding_model.onnx sur les 76 dernières trames → 1 vecteur de 96 par bloc
 *   → classifieur du mot (ex. hey_jarvis) sur les 16 derniers vecteurs → score 0..1.
 *
 * Le NPU n'accepte que des formes statiques : chaque modèle est figé (`reshape("[…]")`) puis compilé
 * sur le premier périphérique qui l'accepte, NPU → GPU.0 → CPU (PLAN §7.3), chaque essai journalisé,
 * jamais d'échec silencieux. « Accepter » = compiler ET calculer juste : une entrée sonde passe sur le
 * périphérique et sur le CPU (référence FP32), écart max ≤ 1 % de l'amplitude de la référence, sinon le
 * périphérique est refusé (mesuré : le mel sur NPU rend −42 dB au lieu de −100 dB sur le silence — le
 * plancher `log(1e-10)` sous-déborde en FP16 — alors que l'embedding et le classifieur y sont justes).
 * Une inférence à la fois (file) : le NPU ne se partage pas.
 *
 * Écarts assumés à openWakeWord : contexte initial = 480 zéros (openWakeWord : tampon vide), et aucun
 * score avant 16 vecteurs RÉELS (≈ 1,3 s) au lieu d'un tampon amorcé sur du bruit aléatoire et des 5
 * premières prédictions forcées à 0 — même effet (pas de détection au démarrage), sans hasard.
 */
import { existsSync } from "node:fs";

export const WAKEWORD_SAMPLE_RATE = 16_000;
/** 80 ms à 16 kHz : l'unité de traitement d'openWakeWord. */
export const WAKEWORD_CHUNK = 1280;
const MEL_CONTEXT = 480; // 160 × 3 (utils.py `_streaming_melspectrogram`)
const MEL_BANDS = 32;
const MEL_WINDOW = 76;
const MEL_MAX = 970; // 10 × 97 trames
const EMBEDDING = 96;
const FEATURE_WINDOW = 16;
const FEATURE_MAX = 120;
/** Écart toléré entre un périphérique et le CPU sur l'entrée sonde, relatif à l'amplitude du CPU. */
const NUMERIC_TOLERANCE = 0.01;

/**
 * Entrée sonde déterministe : pour le mel, 20 ms de silence puis un son (le plancher du silence est ce
 * qui casse en FP16) ; pour les autres, une sinusoïde dans la plage des vrais descripteurs.
 */
function probeInput(shape: number[], audio: boolean): Float32Array {
  const n = shape.reduce((a, b) => a * b, 1);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = audio ? (i < 320 ? 0 : Math.round(8000 * Math.sin(i * 0.07) + 3000 * Math.sin(i * 0.31))) : 1 + 2 * Math.sin(i * 0.37);
  }
  return x;
}

export interface WakeWordConfig {
  /** `melspectrogram.onnx` d'openWakeWord. */
  melModel: string;
  /** `embedding_model.onnx` d'openWakeWord. */
  embeddingModel: string;
  /** Classifieur(s) par nom de mot (`hey_jarvis` → `hey_jarvis_v0.1.onnx`) ; `.onnx` ou `.tflite`. */
  models: Record<string, string>;
  /** Score à partir duquel le mot est détecté (défaut openWakeWord : 0,5). */
  threshold?: number;
  /** Après une détection, le même mot est ignoré pendant ce délai (audio), pour qu'un mot = une détection. */
  debounceMs?: number;
  /** Ordre d'essai des périphériques (défaut NPU, puis iGPU, puis CPU). */
  devices?: string[];
}

export interface WakeWordDetection {
  model: string;
  score: number;
  /** Position dans le flux, en millisecondes d'audio depuis le début (ou le dernier `reset`). */
  atMs: number;
}

export interface WakeWordMetrics {
  /** Périphérique effectif par modèle (`mel`, `embedding`, puis chaque mot). */
  devices: Record<string, string>;
  attempts: { model: string; device: string; ok: boolean; ms: number; error?: string }[];
  chunks: number;
  /** Latence d'un bloc complet (mel + embedding + classifieurs), en ms. */
  p50Ms: number | null;
  p95Ms: number | null;
  lastError: string | null;
}

/** Un modèle compilé : entrée à plat → sortie à plat. */
export type CompiledModel = (input: Float32Array) => Promise<Float32Array>;

/** Ce que le détecteur demande à OpenVINO — remplaçable en test. */
export interface WakeWordRuntime {
  compile(path: string, shape: number[], device: string): Promise<CompiledModel>;
}

/** Runtime réel : `openvino-node`, chargé paresseusement (le CLI ne charge pas les DLL). */
export function openVinoRuntime(): WakeWordRuntime {
  let core: Promise<{ ov: typeof import("openvino-node").addon; core: InstanceType<typeof import("openvino-node").addon.Core> }> | null = null;
  const load = () =>
    (core ??= import("openvino-node").then(({ addon: ov }) => ({ ov, core: new ov.Core() })));
  return {
    async compile(path, shape, device) {
      const { ov, core: c } = await load();
      const model = await c.readModel(path);
      model.reshape(`[${shape.join(",")}]`);
      const compiled = await c.compileModel(model, device);
      const request = compiled.createInferRequest();
      return async (input) => {
        const out = await request.inferAsync([new ov.Tensor(ov.element.f32, shape, input)]);
        return Float32Array.from(Object.values(out)[0]!.data as Float32Array);
      };
    },
  };
}

const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

export class WakeWordDetector {
  private readonly threshold: number;
  private readonly debounceMs: number;
  private readonly devices: string[];
  private models: Promise<{ mel: CompiledModel; embedding: CompiledModel; words: Map<string, CompiledModel> }> | null = null;
  private readonly effective: Record<string, string> = {};
  private readonly attempts: WakeWordMetrics["attempts"] = [];
  private readonly latencies: number[] = [];
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  // État du flux
  private context = new Float32Array(MEL_CONTEXT);
  private remainder = new Int16Array(0);
  private mel: Float32Array[] = [];
  private features: Float32Array[] = [];
  private realFeatures = 0;
  private samples = 0;
  private chunks = 0;
  private readonly lastDetection = new Map<string, number>();

  constructor(
    private readonly cfg: WakeWordConfig,
    private readonly runtime: WakeWordRuntime = openVinoRuntime(),
    private readonly log: (line: string) => void = () => {},
  ) {
    this.threshold = cfg.threshold ?? 0.5;
    this.debounceMs = cfg.debounceMs ?? 1500;
    this.devices = cfg.devices ?? ["NPU", "GPU.0", "CPU"];
    if (!Object.keys(cfg.models).length) throw new Error("WAKEWORD_NO_MODEL: aucun mot d'activation configuré.");
    this.reset();
  }

  /** Les mots écoutés. */
  words(): string[] {
    return Object.keys(this.cfg.models);
  }

  /** Remet le flux à zéro (nouvel enregistrement) ; les modèles compilés restent. */
  reset(): void {
    this.context = new Float32Array(MEL_CONTEXT);
    this.remainder = new Int16Array(0);
    this.mel = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MEL_BANDS).fill(1));
    this.features = [];
    this.realFeatures = 0;
    this.samples = 0;
    this.lastDetection.clear();
  }

  /** Compile les modèles maintenant (sinon : au premier bloc). */
  warmup(): Promise<void> {
    return this.load().then(() => undefined);
  }

  private async compile(name: string, path: string, shape: number[]): Promise<CompiledModel> {
    if (!existsSync(path)) throw new Error(`WAKEWORD_NO_MODEL: modèle introuvable (${name} : ${path}).`);
    const probe = probeInput(shape, name === "mel");
    let reference: Float32Array | null = null;
    for (const device of this.devices) {
      const t0 = Date.now();
      try {
        const m = await this.runtime.compile(path, shape, device);
        if (device !== "CPU") {
          reference ??= await (await this.runtime.compile(path, shape, "CPU"))(probe);
          const got = await m(probe);
          const scale = Math.max(1e-3, ...Array.from(reference, Math.abs));
          const diff = Math.max(...Array.from(reference, (v, i) => Math.abs(v - (got[i] ?? Number.NaN))));
          if (!(diff <= NUMERIC_TOLERANCE * scale)) {
            throw new Error(`écart numérique ${diff.toPrecision(3)} > ${(NUMERIC_TOLERANCE * scale).toPrecision(3)} (1 % de l'amplitude CPU)`);
          }
        }
        this.attempts.push({ model: name, device, ok: true, ms: Date.now() - t0 });
        this.effective[name] = device;
        this.log(`${name} compilé sur ${device} en ${Date.now() - t0} ms`);
        return m;
      } catch (e) {
        const error = (e as Error).message.split("\n").find((l) => l.trim() && !/^Exception from/.test(l)) ?? (e as Error).message;
        this.attempts.push({ model: name, device, ok: false, ms: Date.now() - t0, error });
        this.log(`${name} : ${device} refusé (${error}), essai suivant`);
      }
    }
    throw new Error(`WAKEWORD_NO_DEVICE: aucun périphérique n'a compilé ${name} (${this.devices.join(", ")}).`);
  }

  private load() {
    if (!this.models) {
      this.models = (async () => {
        const mel = await this.compile("mel", this.cfg.melModel, [1, MEL_CONTEXT + WAKEWORD_CHUNK]);
        const embedding = await this.compile("embedding", this.cfg.embeddingModel, [1, MEL_WINDOW, MEL_BANDS, 1]);
        const words = new Map<string, CompiledModel>();
        for (const [name, path] of Object.entries(this.cfg.models)) {
          words.set(name, await this.compile(name, path, [1, FEATURE_WINDOW, EMBEDDING]));
        }
        return { mel, embedding, words };
      })();
      this.models.catch((e: unknown) => {
        this.lastError = (e as Error).message;
        this.models = null;
      });
    }
    return this.models;
  }

  /**
   * Ajoute du PCM 16 kHz mono (int16) au flux. Rend le score de chaque mot pour chaque bloc complet de
   * 80 ms traité, et les détections (score ≥ seuil, hors délai anti-rebond). Les appels sont sérialisés.
   */
  process(pcm: Int16Array): Promise<{ scores: Record<string, number>[]; detections: WakeWordDetection[] }> {
    const run = this.queue.then(() => this.processNow(pcm));
    this.queue = run.catch(() => {});
    return run;
  }

  private async processNow(pcm: Int16Array) {
    const m = await this.load();
    const all = new Int16Array(this.remainder.length + pcm.length);
    all.set(this.remainder);
    all.set(pcm, this.remainder.length);
    const whole = all.length - (all.length % WAKEWORD_CHUNK);
    this.remainder = all.slice(whole);
    const scores: Record<string, number>[] = [];
    const detections: WakeWordDetection[] = [];
    try {
      for (let off = 0; off < whole; off += WAKEWORD_CHUNK) {
        const t0 = performance.now();
        const chunk = all.subarray(off, off + WAKEWORD_CHUNK);
        // Mel : contexte (480) + bloc (1280), en valeurs int16 converties en flottants (comme openWakeWord).
        const melIn = new Float32Array(MEL_CONTEXT + WAKEWORD_CHUNK);
        melIn.set(this.context);
        for (let i = 0; i < chunk.length; i++) melIn[MEL_CONTEXT + i] = chunk[i]!;
        this.context = melIn.slice(melIn.length - MEL_CONTEXT);
        const melOut = await m.mel(melIn);
        for (let f = 0; f + MEL_BANDS <= melOut.length; f += MEL_BANDS) {
          this.mel.push(melOut.slice(f, f + MEL_BANDS).map((v) => v / 10 + 2));
        }
        if (this.mel.length > MEL_MAX) this.mel.splice(0, this.mel.length - MEL_MAX);
        // Embedding : les 76 dernières trames.
        const window = new Float32Array(MEL_WINDOW * MEL_BANDS);
        this.mel.slice(-MEL_WINDOW).forEach((row, i) => window.set(row, i * MEL_BANDS));
        this.features.push(await m.embedding(window));
        if (this.features.length > FEATURE_MAX) this.features.splice(0, this.features.length - FEATURE_MAX);
        this.realFeatures++;
        this.samples += WAKEWORD_CHUNK;
        this.chunks++;
        const atMs = (this.samples * 1000) / WAKEWORD_SAMPLE_RATE;
        const s: Record<string, number> = {};
        if (this.realFeatures >= FEATURE_WINDOW) {
          const input = new Float32Array(FEATURE_WINDOW * EMBEDDING);
          this.features.slice(-FEATURE_WINDOW).forEach((v, i) => input.set(v, i * EMBEDDING));
          for (const [name, word] of m.words) {
            const score = (await word(input))[0] ?? 0;
            s[name] = score;
            const last = this.lastDetection.get(name);
            if (score >= this.threshold && (last === undefined || atMs - last >= this.debounceMs)) {
              this.lastDetection.set(name, atMs);
              detections.push({ model: name, score, atMs });
            }
          }
        } else {
          for (const name of m.words.keys()) s[name] = 0;
        }
        scores.push(s);
        this.latencies.push(performance.now() - t0);
        if (this.latencies.length > 1000) this.latencies.splice(0, this.latencies.length - 1000);
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
    return { scores, detections };
  }

  metrics(): WakeWordMetrics {
    return {
      devices: { ...this.effective },
      attempts: [...this.attempts],
      chunks: this.chunks,
      p50Ms: percentile(this.latencies, 50),
      p95Ms: percentile(this.latencies, 95),
      lastError: this.lastError,
    };
  }
}

/** PCM 16 bits mono d'un WAV (RIFF), avec son débit — le détecteur exige 16 kHz. */
export function readWavPcm16(buf: Buffer): { sampleRate: number; pcm: Int16Array } {
  if (buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") throw new Error("WAV invalide");
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      if (channels !== 1 || bits !== 16) throw new Error(`WAV non pris en charge (${channels} canaux, ${bits} bits) : mono 16 bits attendu`);
      const data = buf.subarray(off + 8, off + 8 + size);
      return { sampleRate, pcm: new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length)) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV sans données");
}
