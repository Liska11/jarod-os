/**
 * @jarod/plugin-llm — `ctx.llm` : fournisseurs (contrat `@jarod/contracts/llm` : stream + usage +
 * AbortSignal), disjoncteur de repli, routeur HTTP, superviseur llama-server, moteur llama.cpp,
 * Hugging Face, sonde des serveurs locaux. Câblage repris de `core.ts:357,382-424,1116-1118`.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type {} from "@jarod/plugin-storage";
import { type Context, Service } from "cordis";
import { EngineService } from "./engine.js";
import { HuggingFaceService } from "./huggingface.js";
import { LlamaServerSupervisor, type SpawnedProcess } from "./llama-server.js";
import { LocalModelsService } from "./local-models.js";
import { detectHardware, type Hardware } from "./local.js";
import { ProviderRouter } from "./providers.js";
import { Router } from "./router.js";
import { RoutingService } from "./routing.js";
import { RuntimeProbeService } from "./runtimes.js";

export * from "./anthropic.js";
export * from "./catalog.js";
export * from "./engine.js";
export * from "./engine-autostart.js";
export * from "./gguf-fit.js";
export * from "./gguf-range.js";
export * from "./hf-names.js";
export * from "./hf-fetch.js";
export * from "./hf-fit.js";
export * from "./hf-fit-cache.js";
export * from "./hf-repo.js";
export * from "./hf-transfer.js";
export * from "./huggingface.js";
export * from "./llama-server.js";
export * from "./lmstudio.js";
export * from "./local.js";
export * from "./local-models.js";
export * from "./openai.js";
export * from "./openai-api.js";
export * from "./providers.js";
export * from "./router.js";
export * from "./routing.js";
export * from "./runtimes.js";

declare module "cordis" {
  interface Context {
    llm: LlmService;
  }
}

export class LlmService extends Service {
  static readonly inject = ["storage"];
  readonly providers: ProviderRouter;
  readonly routing = new RoutingService();
  readonly router = new Router();
  readonly runtimes = new RuntimeProbeService();
  readonly huggingface = new HuggingFaceService();
  /** La surveillance d'un serveur de modèles local. Ne démarre rien tout seul. */
  readonly localServer: LlamaServerSupervisor;
  /** The llama.cpp engine: install, update, presets (drives `localServer`). */
  readonly engine: EngineService;
  /** Local models in memory (llama.cpp, LM Studio): load, unload, hotswap. */
  readonly localModels: LocalModelsService;
  private readonly engineLog: string[] = [];
  private hardware: Promise<Hardware> | null = null;

  constructor(ctx: Context) {
    super(ctx, "llm");
    const { dataDir, settings } = ctx.storage;
    this.providers = new ProviderRouter(settings);
    this.localServer = new LlamaServerSupervisor({
      // spawn sans shell : une ligne de commande concaténée est une injection qui attend. Ce que le
      // serveur écrit sur stderr est gardé (les 60 dernières lignes) : c'est là qu'il dit pourquoi un
      // modèle ne se charge pas.
      spawn: (bin, args) => {
        const child = spawn(bin, args, { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        child.stderr?.on("data", (chunk: Buffer) => {
          for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) this.engineLog.push(line);
          if (this.engineLog.length > 60) this.engineLog.splice(0, this.engineLog.length - 60);
        });
        return child as unknown as SpawnedProcess;
      },
      // La sonde mesurée sur un vrai llama-server : GET /health rend 200 quand il est prêt.
      probe: async (url, timeoutMs) => {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
          return response.ok;
        } catch {
          return false;
        }
      },
    });
    this.engine = new EngineService({
      dir: join(dataDir, "engine"),
      settings,
      supervisor: this.localServer,
      hardware: () => this.detectHardware(),
      untar: (archive, dest) =>
        new Promise((resolve, reject) => {
          const tar = spawn("tar", ["-xzf", archive, "-C", dest], { shell: false, stdio: "ignore" });
          tar.on("error", reject);
          tar.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar a échoué (code ${code})`))));
        }),
      logs: () => [...this.engineLog],
    });
    this.localModels = new LocalModelsService({ settings, engine: this.engine, providers: this.providers });
    // Le contrôle d'inactivité (2026-10-21) s'arrête avec le plugin.
    const localModels = this.localModels;
    ctx.effect(() => () => localModels.dispose(), "llm:local-models-idle");
    // Jarod stops what it started when it quits (engine.ts, en-tête).
    const supervisor = this.localServer;
    ctx.effect(() => async () => void (await supervisor.stop()), "llm:local-server");
  }

  /** Mémoïsé : la détection interroge l'OS (`core.ts:1116-1118`). */
  detectHardware(): Promise<Hardware> {
    this.hardware ??= detectHardware();
    return this.hardware;
  }
}

export default LlmService;
