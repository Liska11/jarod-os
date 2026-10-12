/**
 * Capture vocale continue (W10, PLAN §5.3 : « déclenche l'enregistrement puis le STT iGPU ») — Jarod-cordis.
 *
 * Un flux PCM 16 kHz mono (le micro du desktop, par blocs) traverse une machine à états :
 *   `listening`    : chaque bloc va au détecteur du mot d'activation (NPU) ;
 *   `recording`    : après `voice:wake`, l'audio est gardé jusqu'à la fin de la parole — `endSilenceMs` de
 *                    silence après de la parole, ou `maxMs` au total ; sans parole pendant `noSpeechMs`,
 *                    l'enregistrement est abandonné (rien n'est transcrit). La commande n'est « commencée »
 *                    qu'après `minSpeechMs` de parole hors des `wakeTailMs` premiers ms (la fin du mot
 *                    d'activation lui-même) : une pause après « Hey Jarvis » ne coupe pas la commande ;
 *   `transcribing` : WAV → transcription (le fournisseur STT des réglages ; whisper.cpp iGPU pour
 *                    `local-whisper-cpp`), puis retour à `listening`. L'audio reçu pendant ce temps est ignoré.
 * La parole est repérée à l'énergie (RMS par trame de 20 ms ≥ `speechRms`). Ces valeurs sont des réglages
 * du plugin (config `capture`), pas des seuils de gate.
 */
import type { WakeWordDetection } from "./wakeword.js";

export type CaptureState = "listening" | "recording" | "transcribing";

export interface CaptureConfig {
  /** RMS int16 d'une trame de 20 ms à partir duquel elle compte comme parole (défaut 600 ≈ −35 dBFS). */
  speechRms?: number;
  /** Silence après de la parole qui termine l'enregistrement (défaut 900 ms). */
  endSilenceMs?: number;
  /** Aucune parole pendant ce délai après le mot : abandon (défaut 5 s). */
  noSpeechMs?: number;
  /** Durée maximale d'une commande (défaut 15 s). */
  maxMs?: number;
  /** Début d'enregistrement ignoré pour repérer la parole : la fin du mot d'activation (défaut 300 ms). */
  wakeTailMs?: number;
  /** Parole cumulée qui marque le début de la commande (défaut 200 ms). */
  minSpeechMs?: number;
}

export interface CaptureTranscript {
  text: string;
  /** Le mot d'activation qui a ouvert l'enregistrement. */
  wake: WakeWordDetection;
  /** Durée de l'audio transcrit, en ms. */
  audioMs: number;
  /** Durée de la transcription, en ms. */
  sttMs: number;
}

export interface CaptureDeps {
  /** PCM → détections (le détecteur du mot d'activation). */
  detect(pcm: Int16Array): Promise<WakeWordDetection[]>;
  /** Démarré avant la transcription (whisper-server local) ; absent : le fournisseur est déjà là. */
  prepare?: () => Promise<unknown>;
  transcribe(wav: Buffer, mime: string): Promise<string>;
  /** Remise à zéro du détecteur au retour en écoute. */
  resetDetector(): void;
  onState(state: CaptureState, info?: { reason?: string }): void;
  onTranscript(t: CaptureTranscript): void;
  onError(error: Error): void;
}

const RATE = 16_000;
const FRAME = 320; // 20 ms

/** WAV RIFF 16 bits mono 16 kHz. */
export function pcm16ToWav(pcm: Int16Array, sampleRate = RATE): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const rms = (x: Int16Array): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return x.length ? Math.sqrt(s / x.length) : 0;
};

export class VoiceCapture {
  private st: CaptureState = "listening";
  private readonly speechRms: number;
  private readonly endSilenceSamples: number;
  private readonly noSpeechSamples: number;
  private readonly maxSamples: number;
  private readonly wakeTailSamples: number;
  private readonly minSpeechSamples: number;
  private speechSamples = 0;
  private framedSamples = 0;
  private recorded: Int16Array[] = [];
  private recordedSamples = 0;
  private frame = new Int16Array(0);
  private heardSpeech = false;
  private silentSamples = 0;
  private wake: WakeWordDetection | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: CaptureDeps,
    cfg: CaptureConfig = {},
  ) {
    this.speechRms = cfg.speechRms ?? 600;
    this.endSilenceSamples = ((cfg.endSilenceMs ?? 900) * RATE) / 1000;
    this.noSpeechSamples = ((cfg.noSpeechMs ?? 5000) * RATE) / 1000;
    this.maxSamples = ((cfg.maxMs ?? 15_000) * RATE) / 1000;
    this.wakeTailSamples = ((cfg.wakeTailMs ?? 300) * RATE) / 1000;
    this.minSpeechSamples = ((cfg.minSpeechMs ?? 200) * RATE) / 1000;
  }

  state(): CaptureState {
    return this.st;
  }

  /**
   * Ajoute un bloc du micro. Les appels sont sérialisés ; rend l'état après traitement. Un bloc qui
   * arrive pendant une transcription est rejeté à l'appel (pas mis en file pour après).
   */
  feed(pcm: Int16Array): Promise<CaptureState> {
    if (this.st === "transcribing") return Promise.resolve(this.st);
    const run = this.queue.then(() => this.feedNow(pcm));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Abandonne un enregistrement en cours et revient à l'écoute. */
  cancel(reason = "annulé"): void {
    if (this.st === "recording") this.toListening(reason);
  }

  private setState(s: CaptureState, reason?: string): void {
    this.st = s;
    this.deps.onState(s, reason ? { reason } : undefined);
  }

  private toListening(reason?: string): void {
    this.recorded = [];
    this.recordedSamples = 0;
    this.frame = new Int16Array(0);
    this.heardSpeech = false;
    this.silentSamples = 0;
    this.speechSamples = 0;
    this.framedSamples = 0;
    this.wake = null;
    this.deps.resetDetector();
    this.setState("listening", reason);
  }

  private async feedNow(pcm: Int16Array): Promise<CaptureState> {
    if (this.st === "transcribing") return this.st; // mis en file juste avant la fin d'un enregistrement
    if (this.st === "listening") {
      let detections: WakeWordDetection[];
      try {
        detections = await this.deps.detect(pcm);
      } catch (e) {
        this.deps.onError(e as Error);
        return this.st;
      }
      if (!detections.length) return this.st;
      this.wake = detections[0]!;
      this.setState("recording");
      // Démarre le STT local pendant que l'utilisateur parle (whisper-server : ~1 s sur l'iGPU).
      if (this.deps.prepare) this.deps.prepare().catch((e: unknown) => this.deps.onError(e as Error));
      return this.st;
    }
    // recording
    this.recorded.push(pcm);
    this.recordedSamples += pcm.length;
    const all = new Int16Array(this.frame.length + pcm.length);
    all.set(this.frame);
    all.set(pcm, this.frame.length);
    let off = 0;
    for (; off + FRAME <= all.length; off += FRAME) {
      this.framedSamples += FRAME;
      if (this.framedSamples <= this.wakeTailSamples) continue; // fin du mot d'activation
      if (rms(all.subarray(off, off + FRAME)) >= this.speechRms) {
        this.speechSamples += FRAME;
        if (this.speechSamples >= this.minSpeechSamples) this.heardSpeech = true;
        this.silentSamples = 0;
      } else {
        this.silentSamples += FRAME;
      }
    }
    this.frame = all.slice(off);
    if (!this.heardSpeech && this.recordedSamples >= this.noSpeechSamples) {
      this.toListening("aucune parole après le mot d'activation");
      return this.st;
    }
    if ((this.heardSpeech && this.silentSamples >= this.endSilenceSamples) || this.recordedSamples >= this.maxSamples) {
      await this.finish();
    }
    return this.st;
  }

  private async finish(): Promise<void> {
    const wake = this.wake!;
    const pcm = new Int16Array(this.recordedSamples);
    let o = 0;
    for (const c of this.recorded) {
      pcm.set(c, o);
      o += c.length;
    }
    this.setState("transcribing");
    const t0 = Date.now();
    try {
      if (this.deps.prepare) await this.deps.prepare();
      const text = await this.deps.transcribe(pcm16ToWav(pcm), "audio/wav");
      this.deps.onTranscript({ text, wake, audioMs: (pcm.length * 1000) / RATE, sttMs: Date.now() - t0 });
      this.toListening();
    } catch (e) {
      this.deps.onError(e as Error);
      this.toListening("transcription échouée");
    }
  }
}
