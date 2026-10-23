// Portage de packages/core/src/services/llama-server.ts (rév. 2e180305).
import { existsSync } from "node:fs";

export interface LlamaServerConfig {
  /** Le chemin du binaire. Jamais deviné : sur cette machine, il n'est même pas lisible. */
  bin: string;
  /** Le modèle à charger, tel quel dans argv. */
  model: string;
  port: number;
  /** Des arguments supplémentaires, ajoutés sans passer par un shell. */
  extraArgs?: string[];
  ctxSize?: number;
  gpuLayers?: number;
}

export interface LlamaServerState {
  running: boolean;
  ready: boolean;
  port: number | null;
  pid: number | null;
  model: string | null;
  restarts: number;
  lastError: string | null;
}

export interface SpawnedProcess {
  pid: number | undefined;
  kill: (signal?: string) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * Surveille un serveur de modèles local.
 *
 * Rien ne pilotait llama-server : il fallait le lancer à la main, dans un autre terminal, avec ses
 * arguments, et l'agent s'y connectait en espérant qu'il soit là. Deux choses rendent ce pilotage
 * dangereux si on le fait à la légère, et chacune a sa règle ici.
 *
 * D'abord, le chemin du binaire : sur cette machine, le serveur tourne sous un autre compte et
 * Windows refuse de dire d'où il vient. Un superviseur qui « devine » un chemin lancerait autre
 * chose que ce que l'utilisateur croit — celui-ci exige le chemin, et refuse de démarrer sans lui.
 *
 * Ensuite, la propriété du processus : il y a DÉJÀ un serveur qui écoute. Un superviseur qui
 * s'approprie ce qu'il trouve finit par tuer un travail qui n'est pas le sien. Celui-ci ne connaît
 * que l'enfant qu'il a lancé, l'annonce quand le port est déjà pris, et n'adopte rien.
 */
export class LlamaServerSupervisor {
  private child: SpawnedProcess | null = null;
  private config: LlamaServerConfig | null = null;
  private ready = false;
  private restarts = 0;
  private lastError: string | null = null;

  constructor(
    private readonly d: {
      spawn: (bin: string, args: string[]) => SpawnedProcess;
      /** La sonde de disponibilité. Mesurée sur un vrai serveur : GET /health rend 200. */
      probe: (url: string, timeoutMs: number) => Promise<boolean>;
      readinessTimeoutMs?: number;
      maxRestarts?: number;
      backoffMs?: number;
      /** Attente maximale du silence du port après l'arrêt (10 s par défaut). */
      stopWaitMs?: number;
    },
  ) {}

  status(): LlamaServerState {
    return {
      running: this.child !== null,
      ready: this.ready,
      port: this.config?.port ?? null,
      pid: this.child?.pid ?? null,
      model: this.config?.model ?? null,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }

  /**
   * Un serveur répond sur ce port sans être l'enfant de ce superviseur (lancé par un autre programme, ou survivant d'une session précédente) :
   * il n'est jamais arrêté ici, seulement signalé.
   */
  async foreignOn(port: number): Promise<boolean> {
    if (this.child) return false;
    return this.d.probe(`http://127.0.0.1:${port}/health`, 1_000);
  }

  /** Construit argv sans shell : une ligne de commande concaténée est une injection qui attend. */
  static args(config: LlamaServerConfig): string[] {
    const args = ["-m", config.model, "--port", String(config.port), "--host", "127.0.0.1"];
    if (config.ctxSize) args.push("-c", String(config.ctxSize));
    if (config.gpuLayers !== undefined) args.push("-ngl", String(config.gpuLayers));
    return [...args, ...(config.extraArgs ?? [])];
  }

  /**
   * Démarre le serveur et attend qu'il réponde. Refuse plutôt que d'inventer : sans chemin, on ne
   * lance rien ; sur un port déjà pris, on ne s'approprie rien.
   */
  async start(config: LlamaServerConfig): Promise<LlamaServerState> {
    if (this.child) return this.status();
    if (!config.bin) throw new Error("LLAMA_NO_BINARY: le chemin de llama-server n'est pas configuré");
    if (!existsSync(config.bin)) throw new Error(`LLAMA_BINARY_MISSING: ${config.bin} n'existe pas`);
    if (!config.model) throw new Error("LLAMA_NO_MODEL: aucun modèle à charger");

    // Un serveur répond déjà ? Ce n'est pas le nôtre : on le dit, et on n'y touche pas.
    if (await this.d.probe(`http://127.0.0.1:${config.port}/health`, 2_000)) {
      throw new Error(`LLAMA_PORT_BUSY: quelque chose répond déjà sur le port ${config.port}`);
    }

    this.config = config;
    this.spawnOnce();
    const timeout = this.d.readinessTimeoutMs ?? 120_000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      // Le processus peut mourir avant d'être prêt : attendre un mort est une attente sans fin.
      if (!this.child)
        throw new Error(`LLAMA_DIED: le serveur s'est arrêté avant d'être prêt — ${this.lastError ?? "sans message"}`);
      if (await this.d.probe(`http://127.0.0.1:${config.port}/health`, 2_000)) {
        this.ready = true;
        return this.status();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // Personne ne répond après le délai : on ne laisse pas traîner un processus à moitié vivant.
    await this.stop();
    throw new Error(`LLAMA_NOT_READY: aucune réponse sur le port ${config.port} après ${timeout} ms`);
  }

  /** Remplace un enfant mort, dans la limite du plafond. Au-delà, on arrête et on dit pourquoi. */
  private spawnOnce(): void {
    const config = this.config as LlamaServerConfig;
    const child = this.d.spawn(config.bin, LlamaServerSupervisor.args(config));
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

  /**
   * Arrête l'enfant qu'on a lancé — et seulement lui. Rend false si rien n'était lancé. Attend ensuite que le port se taise (borné par
   * `stopWaitMs`) : un échange de modèle relance aussitôt un serveur sur le même port, et l'ancien, encore en train de mourir, le ferait
   * prendre pour un serveur étranger (`LLAMA_PORT_BUSY`).
   */
  async stop(): Promise<boolean> {
    const child = this.child;
    const port = this.config?.port ?? null;
    this.child = null;
    this.ready = false;
    this.lastError = null;
    this.config = null;
    if (!child) return false;
    child.kill("SIGTERM");
    if (port !== null) {
      const deadline = Date.now() + (this.d.stopWaitMs ?? 10_000);
      while (Date.now() < deadline && (await this.d.probe(`http://127.0.0.1:${port}/health`, 500))) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return true;
  }
}
