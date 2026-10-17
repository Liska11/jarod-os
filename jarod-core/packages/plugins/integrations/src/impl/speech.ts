/**
 * C1 (silero-vad) — détection d'activité vocale entre la capture et Whisper.
 * C2 (sherpa-onnx) — reconnaissance vocale locale dans un processus natif séparé.
 *
 * C1 : une machine à hystérésis sur des probabilités de parole par trame. Le modèle silero (ONNX) est un `scorer`
 * injecté ; sans lui, le repli est une énergie RMS (moins fin, mais réel et sans modèle). C2 : aucun audio ne part vers
 * le cloud par défaut ; un moteur déclaré distant est refusé tant que `allowCloudAudio` n'est pas vrai.
 */
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export type FrameScorer = (frame: Float32Array) => number;

/** Énergie RMS ramenée à [0,1] (repli sans modèle). */
export function energyScorer(full = 0.1): FrameScorer {
  return (frame) => {
    let sum = 0;
    for (const x of frame) sum += x * x;
    return Math.min(1, Math.sqrt(sum / Math.max(1, frame.length)) / full);
  };
}

export interface VadConfig {
  /** Seuil pour entrer en parole. */
  start: number;
  /** Seuil plus bas pour en sortir (hystérésis). */
  stop: number;
  /** Trames consécutives sous `stop` avant de clore un segment. */
  hangoverFrames: number;
  /** Trames minimales d'un segment gardé (les clics sont écartés). */
  minFrames: number;
}

export const DEFAULT_VAD: VadConfig = { start: 0.6, stop: 0.35, hangoverFrames: 8, minFrames: 3 };

export interface Segment {
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
}

export function segmentSpeech(frames: Float32Array[], scorer: FrameScorer, config: VadConfig = DEFAULT_VAD): Segment[] {
  if (config.stop > config.start) throw new AdapterRefused("C1", "le seuil de sortie ne peut pas dépasser le seuil d'entrée");
  const out: Segment[] = [];
  let start = -1;
  let below = 0;
  let last = -1;
  const close = () => {
    if (start >= 0 && last - start + 1 >= config.minFrames) out.push({ startFrame: start, endFrame: last + 1 });
    start = -1;
    below = 0;
  };
  frames.forEach((f, i) => {
    const p = scorer(f);
    if (!Number.isFinite(p)) throw new AdapterRefused("C1", "le modèle a rendu une probabilité invalide");
    if (start < 0) {
      if (p >= config.start) {
        start = i;
        last = i;
        below = 0;
      }
    } else if (p >= config.stop) {
      last = i;
      below = 0;
    } else if (++below >= config.hangoverFrames) close();
  });
  close();
  return out;
}

// ---------------------------------------------------------------- C2

export interface SttEngine {
  /** `local` : processus natif sur cette machine. `remote` : l'audio quitte la machine. */
  locality: "local" | "remote";
  transcribe(pcm: Float32Array, sampleRate: number): Promise<{ text: string; confidence: number }>;
}

export interface SttOptions {
  allowCloudAudio?: boolean;
  maxSeconds?: number;
  minConfidence?: number;
}

export class LocalStt {
  constructor(private readonly engine: SttEngine | undefined, private readonly opts: SttOptions = {}) {}

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    if (!this.engine) throw new AdapterUnavailable("C2", "moteur sherpa-onnx non installé (action humaine)");
    if (this.engine.locality !== "local" && this.opts.allowCloudAudio !== true) throw new AdapterRefused("C2", "moteur distant : l'audio ne quitte pas la machine par défaut");
    if (!(sampleRate >= 8000 && sampleRate <= 48000)) throw new AdapterRefused("C2", "fréquence d'échantillonnage hors [8000, 48000]");
    if (pcm.length / sampleRate > (this.opts.maxSeconds ?? 120)) throw new AdapterRefused("C2", "audio trop long");
    if (pcm.some((x) => !Number.isFinite(x))) throw new AdapterRefused("C2", "échantillons invalides");
    const r = await this.engine.transcribe(pcm, sampleRate);
    if (r.confidence < (this.opts.minConfidence ?? 0.3)) return "";
    // Le texte reconnu est une donnée : bornée et sans caractères de contrôle, avant d'aller plus loin.
    // eslint-disable-next-line no-control-regex
    return r.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000);
  }
}
