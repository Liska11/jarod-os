/**
 * @jarod/plugin-voice — `ctx.voice` : transcription (`services/voice.ts`, compatible OpenAI) et
 * dictée locale sans clé : whisper.cpp (Vulkan, iGPU) supervisé (gap G3, PLAN §4).
 * Câblage `core.ts:1112-1113`. TTS : `speech.ts` porté (`core.ts:246,503` : `core.speech`) → `ctx.voice.speech`
 * (SAPI / say / espeak) + Piper (PLAN §4.3, voix `piper:<nom>`, chemins en config `piper`).
 * Mot d'activation (PLAN §5.3, W10) : openWakeWord sur NPU (`wakeword.ts`), config `wakeword` ;
 * `ctx.voice.listen(pcm)` alimente le détecteur et émet `voice:wake` à chaque détection.
 * Capture continue (`capture.ts`) : `ctx.voice.capture.feed(pcm)` → `voice:wake` → enregistrement →
 * whisper-server démarré à la demande → transcription → `voice:transcript` (+ `voice:state`, `voice:error`).
 * Isolation (Q9, option A) : avec `wakewordIsolation`, OpenVINO tourne dans un processus dédié
 * (`wakeword-isolated.ts`) — un plantage natif n'emporte plus l'hôte ; sans, dans le processus (CLI, gates).
 */
import { spawn } from "node:child_process";
import type { KernelEvents, VoicePriority } from "@jarod/contracts";
import type {} from "@jarod/plugin-llm";
import type { SpawnedProcess } from "@jarod/plugin-llm";
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { type CaptureConfig, VoiceCapture } from "./capture.js";
import { type PriorityConfig, VoicePriorityGate } from "./priority.js";
import { type PiperConfig, SpeechService } from "./speech.js";
import { transcribe } from "./voice.js";
import { type WakeWordConfig, WakeWordDetector, type WakeWordDetection } from "./wakeword.js";
import { IsolatedWakeWordRuntime, type WorkerExitEvent, type WorkerSpawner, type WorkerStats } from "./wakeword-isolated.js";
import { type WhisperServerConfig, WhisperServerSupervisor } from "./whisper-server.js";

export * from "./capture.js";
export * from "./priority.js";
export * from "./speech.js";
export * from "./voice.js";
export * from "./wakeword.js";
export * from "./wakeword-isolated.js";
export * from "./whisper-server.js";

declare module "cordis" {
  interface Context {
    voice: VoiceService;
  }
  interface Events extends KernelEvents {}
}

export interface VoiceConfig {
  /** whisper.cpp local ; absent = seuls les fournisseurs distants/locaux déjà configurés servent. */
  whisper?: Partial<WhisperServerConfig> & { bin: string; model: string; autoStart?: boolean };
  /** Piper (TTS neuronal CPU) : binaire + modèle par voix ; absent = moteur vocal de l'OS seul. */
  piper?: PiperConfig;
  /** Mot d'activation openWakeWord (modèles mel + embedding + classifieurs) ; absent = pas d'écoute. */
  wakeword?: WakeWordConfig & { warmup?: boolean };
  /** Fin de parole de la capture continue (exige `wakeword`). */
  capture?: CaptureConfig;
  /** Priorité de la voix sur l'ingestion (SPECS-P5-VOIX-PRIORITAIRE.md) ; `enabled: false` = condition témoin du banc. */
  priority?: PriorityConfig;
  /**
   * Mot d'activation hors du processus hôte (desktop : `utilityProcess`, Q9) — fourni par l'hôte, pas
   * par `voice.json`. Absent : OpenVINO dans le processus courant.
   */
  wakewordIsolation?: { spawn: WorkerSpawner; onExit?: (event: WorkerExitEvent) => void };
}

export interface VoiceService {
  /** Speech-to-text through the configured provider (`core.transcribe`, core.ts:1112). */
  transcribe(audio: Buffer, mime: string): Promise<string>;
  whisper: WhisperServerSupervisor;
  /** Démarre whisper-server avec la config du plugin (défauts : port 8910, `fr`, iGPU = Vulkan 1). */
  startWhisper(): Promise<ReturnType<WhisperServerSupervisor["status"]>>;
  /** Dernières lignes écrites par whisper-server (périphérique Vulkan choisi, erreurs de modèle). */
  whisperLog(): string[];
  /** Synthèse vocale locale (`core.speech`) : moteur de l'OS + voix Piper configurées. */
  speech: SpeechService;
  /** Détecteur du mot d'activation (null : non configuré). */
  wakeword: WakeWordDetector | null;
  /** Processus dédié du mot d'activation : pid, démarrages, plantages (null : dans le processus courant). */
  wakewordWorker(): WorkerStats | null;
  /** PCM 16 kHz mono → détecteur ; chaque détection est aussi émise sur `voice:wake`. */
  listen(pcm: Int16Array): Promise<WakeWordDetection[]>;
  /** Capture continue mot → commande → texte (null : pas de mot d'activation configuré). */
  capture: VoiceCapture | null;
  /** Priorité de la voix : active de la détection du mot d'activation à la fin de la transcription (lue par `rag`). */
  priority: VoicePriority;
  /** Parle le texte si autoSpeak=true dans les réglages. Retourne { spoken, reason?, chars?, truncated?, voice?, rate? }. */
  speak(text: string): Promise<{ spoken: boolean; reason?: string; chars?: number; truncated?: boolean; voice?: string; rate?: number }>;
}

export const name = "voice";
export const inject = ["storage", "llm"];

export async function apply(ctx: Context, config: VoiceConfig = {}): Promise<void> {
  const log: string[] = [];
  const whisper = new WhisperServerSupervisor({
    spawn: (bin, args) => {
      const child = spawn(bin, args, { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) log.push(line);
        if (log.length > 200) log.splice(0, log.length - 200);
      });
      return child as unknown as SpawnedProcess;
    },
    probe: async (url, timeoutMs) => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok;
      } catch {
        return false;
      }
    },
  });
  const w = config?.whisper;
  const resolved = (): WhisperServerConfig => {
    if (!w) throw new Error("WHISPER_NOT_CONFIGURED: aucun whisper-server configuré (plugin voice, `whisper`).");
    return { port: 8910, language: "fr", device: 1, convert: true, ...w };
  };
  const isolated =
    config?.wakeword && config.wakewordIsolation
      ? new IsolatedWakeWordRuntime({
          spawn: config.wakewordIsolation.spawn,
          log: (l, level) => ctx.logger("voice")[level](l),
          ...(config.wakewordIsolation.onExit ? { onExit: config.wakewordIsolation.onExit } : {}),
        })
      : null;
  const priority = new VoicePriorityGate(config?.priority, (l) => ctx.logger("voice").warn(l));
  const service: VoiceService = {
    // Toute transcription (mot d'activation, bouton micro, messages vocaux) ouvre la fenêtre de priorité le temps de l'appel.
    transcribe: (audio, mime) => priority.track(() => transcribe(ctx.llm.providers, ctx.storage.settings, audio, mime)),
    whisper,
    startWhisper: async () => whisper.start(resolved()),
    whisperLog: () => [...log],
    speech: new SpeechService(config?.piper ? { piper: config.piper } : {}),
    /** Lit autoSpeak/ttsRate des réglages et parle si autoSpeak=true. Retourne { spoken, reason?, chars?, rate? }. */
    speak: async (text: string) => {
      const v = ctx.storage.settings.get("voice");
      if (!v.autoSpeak) return { spoken: false, reason: "autoSpeak=false" };
      const rate = v.ttsRate ?? 1;
      const clampedRate = Number.isFinite(rate) && rate > 0 ? Math.max(0.25, Math.min(4, rate)) : 1;
      const result = await service.speech.speak(text, { rate: clampedRate });
      return { spoken: true, chars: result.chars, truncated: result.truncated, voice: result.voice, rate: clampedRate };
    },
    wakeword: config?.wakeword ? new WakeWordDetector(config.wakeword, isolated ?? undefined, (l) => ctx.logger("voice").info(l)) : null,
    wakewordWorker: () => isolated?.stats() ?? null,
    listen: async (pcm) => {
      if (!service.wakeword) throw new Error("WAKEWORD_NOT_CONFIGURED: aucun mot d'activation configuré (plugin voice, `wakeword`).");
      const { detections } = await service.wakeword.process(pcm);
      for (const d of detections) ctx.emit("voice:wake", d);
      return detections;
    },
    capture: null,
    priority,
  };
  let starting: Promise<unknown> | null = null;
  service.capture = service.wakeword
    ? new VoiceCapture(
        {
          detect: (pcm) => service.listen(pcm),
          // whisper-server configuré : démarré au mot d'activation (une seule fois), sinon le fournisseur STT des réglages sert tel quel.
          ...(w
            ? {
                prepare: () => {
                  if (whisper.status().ready) return Promise.resolve();
                  starting ??= service.startWhisper().finally(() => (starting = null));
                  return starting;
                },
              }
            : {}),
          transcribe: (wav, mime) => service.transcribe(wav, mime),
          resetDetector: () => service.wakeword!.reset(),
          onState: (state, info) => {
            priority.onCaptureState(state);
            ctx.emit("voice:state", state, info);
          },
          onTranscript: (t) => ctx.emit("voice:transcript", t),
          onError: (e) => {
            ctx.logger("voice").warn(e.message);
            ctx.emit("voice:error", { message: e.message });
          },
        },
        config?.capture,
      )
    : null;
  ctx.provide("voice", service);
  ctx.effect(() => () => priority.dispose(), "voice:priority");
  ctx.effect(() => async () => void (await whisper.stop()), "voice:whisper");
  ctx.effect(() => async () => void (await service.speech.stop()), "voice:speech");
  if (isolated) ctx.effect(() => () => isolated.dispose(), "voice:wakeword-worker");
  if (w?.autoStart) await service.startWhisper();
  if (config?.wakeword?.warmup) await service.wakeword!.warmup();
}
