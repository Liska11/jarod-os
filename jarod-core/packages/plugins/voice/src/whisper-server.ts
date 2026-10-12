/**
 * Superviseur de `whisper-server` (whisper.cpp) : la dictée locale sans clé (gap G3, PLAN §4).
 * Jarod-cordis — même contrat que `LlamaServerSupervisor` (services/llama-server.ts, rév. 2e180305) :
 * spawn sans shell, 127.0.0.1 seulement, prêt quand `/health` répond, un port déjà occupé n'est pas
 * le nôtre, redémarrage borné, arrêt de ce qu'on a lancé.
 *
 * Le point d'accès est servi sous `/v1/audio/transcriptions` (`--inference-path`) : `voice.ts`
 * (`transcribe`, compatible OpenAI) s'en sert sans changement, via le fournisseur `local-whisper-cpp`.
 */
import { existsSync } from "node:fs";
import type { SpawnedProcess } from "@jarod/plugin-llm";

export interface WhisperServerConfig {
  /** `whisper-server(.exe)` compilé avec Vulkan (PLAN §4). */
  bin: string;
  /** Modèle GGML (défaut PLAN : `ggml-large-v3-turbo-q5_0.bin`). */
  model: string;
  port: number;
  /** Langue parlée (`fr`), `auto` pour la détection. */
  language: string;
  /** Index du périphérique Vulkan (`-dev`) : l'iGPU, pour laisser le GPU dédié au chat (PLAN §0.3). */
  device?: number;
  /** Conversion des formats non-WAV (webm du navigateur, ogg des messageries) : exige ffmpeg. */
  convert?: boolean;
  threads?: number;
  extraArgs?: string[];
}

export interface WhisperServerState {
  running: boolean;
  ready: boolean;
  port: number | null;
  pid: number | null;
  model: string | null;
  device: number | null;
  restarts: number;
  lastError: string | null;
}

export const INFERENCE_PATH = "/v1/audio/transcriptions";

export class WhisperServerSupervisor {
  private child: SpawnedProcess | null = null;
  private config: WhisperServerConfig | null = null;
  private ready = false;
  private restarts = 0;
  private lastError: string | null = null;

  constructor(
    private readonly d: {
      spawn: (bin: string, args: string[]) => SpawnedProcess;
      probe: (url: string, timeoutMs: number) => Promise<boolean>;
      readinessTimeoutMs?: number;
      maxRestarts?: number;
      backoffMs?: number;
    },
  ) {}

  status(): WhisperServerState {
    return {
      running: this.child !== null,
      ready: this.ready,
      port: this.config?.port ?? null,
      pid: this.child?.pid ?? null,
      model: this.config?.model ?? null,
      device: this.config?.device ?? null,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  static args(c: WhisperServerConfig): string[] {
    const args = ["-m", c.model, "--host", "127.0.0.1", "--port", String(c.port), "-l", c.language];
    args.push("--inference-path", INFERENCE_PATH);
    if (c.device !== undefined) args.push("-dev", String(c.device));
    if (c.convert) args.push("--convert");
    if (c.threads) args.push("-t", String(c.threads));
    return [...args, ...(c.extraArgs ?? [])];
  }

  /** L'URL de base compatible OpenAI (`…/v1`) quand le serveur est prêt. */
  baseUrl(): string | null {
    return this.ready && this.config ? `http://127.0.0.1:${this.config.port}/v1` : null;
  }

  async start(config: WhisperServerConfig): Promise<WhisperServerState> {
    if (this.child) return this.status();
    if (!config.bin) throw new Error("WHISPER_NO_BINARY: le chemin de whisper-server n'est pas configuré");
    if (!existsSync(config.bin)) throw new Error(`WHISPER_BINARY_MISSING: ${config.bin} n'existe pas`);
    if (!config.model) throw new Error("WHISPER_NO_MODEL: aucun modèle à charger");
    if (!existsSync(config.model)) throw new Error(`WHISPER_MODEL_MISSING: ${config.model} n'existe pas`);
    // Un serveur répond déjà ? Ce n'est pas le nôtre : on le dit, et on n'y touche pas.
    if (await this.d.probe(`http://127.0.0.1:${config.port}/health`, 2_000)) {
      throw new Error(`WHISPER_PORT_BUSY: quelque chose répond déjà sur le port ${config.port}`);
    }
    this.config = config;
    this.spawnOnce();
    const timeout = this.d.readinessTimeoutMs ?? 120_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!this.child)
        throw new Error(`WHISPER_DIED: le serveur s'est arrêté avant d'être prêt — ${this.lastError ?? "sans message"}`);
      if (await this.d.probe(`http://127.0.0.1:${config.port}/health`, 2_000)) {
        this.ready = true;
        return this.status();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.stop();
    throw new Error(`WHISPER_NOT_READY: aucune réponse sur le port ${config.port} après ${timeout} ms`);
  }

  private spawnOnce(): void {
    const config = this.config as WhisperServerConfig;
    const child = this.d.spawn(config.bin, WhisperServerSupervisor.args(config));
    this.child = child;
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.lastError = `le serveur a quitté (code ${String(code)})`;
      if (this.restarts < (this.d.maxRestarts ?? 2)) {
        this.restarts += 1;
        const wait = (this.d.backoffMs ?? 1_000) * this.restarts;
        setTimeout(() => {
          if (this.config && !this.child) this.spawnOnce();
        }, wait);
      }
    });
  }

  async stop(): Promise<boolean> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.lastError = null;
    this.config = null;
    if (!child) return false;
    child.kill("SIGTERM");
    return true;
  }
}
