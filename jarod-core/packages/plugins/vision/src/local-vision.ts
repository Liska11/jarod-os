// Vision locale (30/10) : un llama-server à part, avec un modèle multimodal (Qwen3-VL, LFM2-VL…) et son projecteur d'image (`--mmproj`).
// Il n'est lancé qu'au moment où Jarod doit regarder une image, puis arrêté après un temps d'inactivité : le modèle de conversation (LFM3)
// reste en place, et rien de la capture ne quitte l'ordinateur. Même principe que SttService (plugin-voice) : un seul démarrage à la fois,
// on n'adopte jamais un serveur étranger, on n'arrête que ce qu'on a lancé.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LlamaServerSupervisor, type SpawnedProcess } from "@jarod/plugin-llm";
import type { SettingsService } from "@jarod/plugin-storage";

export const LOCAL_VISION_PROVIDER = "local-vision";
export const LOCAL_VISION_PORT = 8792;
export const LOCAL_VISION_MODEL = "vision-locale";
const IDLE_STOP_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 180_000;

export interface VisionModelFiles {
  model: string;
  mmproj: string;
}

/** Un dossier de modèle multimodal : un .gguf de langage + un `mmproj*.gguf` à côté. Les noms « VL » / « vision » passent en premier. */
export function findVisionModel(modelsDir: string, depth = 3): VisionModelFiles | null {
  const found: { files: VisionModelFiles; score: number }[] = [];
  const walk = (dir: string, left: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const ggufs = names.filter((n) => n.toLowerCase().endsWith(".gguf"));
    const mm = ggufs.find((n) => /mmproj/i.test(n));
    const main = ggufs.filter((n) => !/mmproj/i.test(n)).sort((a, b) => statSync(join(dir, a)).size - statSync(join(dir, b)).size)[0];
    if (mm && main) {
      const label = `${dir}/${main}`;
      // Petit d'abord (la vue d'écran doit être rapide) ; les modèles de vision déclarés comme tels devant les autres.
      const score = (/(vl|vision|llava|minicpm-v|moondream)/i.test(label) ? 0 : 100) + statSync(join(dir, main)).size / 1e10;
      found.push({ files: { model: join(dir, main), mmproj: join(dir, mm) }, score });
    }
    if (left <= 0) return;
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (statSync(p).isDirectory()) walk(p, left - 1);
      } catch {}
    }
  };
  if (existsSync(modelsDir)) walk(modelsDir, depth);
  return found.sort((a, b) => a.score - b.score)[0]?.files ?? null;
}

export class LocalVisionServer {
  private readonly supervisor: LlamaServerSupervisor;
  private starting: Promise<void> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly d: {
      settings: SettingsService;
      /** Remplaçable en test. */
      supervisor?: LlamaServerSupervisor;
    },
  ) {
    this.supervisor =
      d.supervisor ??
      new LlamaServerSupervisor({
        spawn: (bin, args) => spawn(bin, args, { shell: false, stdio: "ignore", windowsHide: true }) as unknown as SpawnedProcess,
        probe: async (url, timeoutMs) => {
          try {
            return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok;
          } catch {
            return false;
          }
        },
        readinessTimeoutMs: READY_TIMEOUT_MS,
      });
  }

  /** Le moteur llama.cpp installé et le modèle de vision trouvé, ou ce qui manque. */
  plan(): { bin: string; files: VisionModelFiles } | { missing: string } {
    const cfg = (this.d.settings.get("localEngine") ?? {}) as { modelsDir?: string; installed?: { bin?: string } | null };
    const bin = cfg.installed?.bin ?? "";
    if (!bin || !existsSync(bin)) return { missing: "le moteur llama.cpp n'est pas installé (Réglages › Modèles locaux)" };
    const dir = cfg.modelsDir || process.env.JAROD_MODELS_DIR || "";
    if (!dir) return { missing: "le dossier des modèles n'est pas réglé" };
    const files = findVisionModel(dir);
    if (!files) return { missing: `aucun modèle de vision (un .gguf avec son mmproj) dans ${dir}` };
    return { bin, files };
  }

  available(): boolean {
    return "bin" in this.plan();
  }

  /** Le serveur de vision tourne et répond ; le lance si besoin (un seul démarrage à la fois). */
  async ensure(): Promise<void> {
    this.touch();
    if (this.supervisor.status().ready) return;
    this.starting ??= this.start().finally(() => (this.starting = null));
    await this.starting;
  }

  private async start(): Promise<void> {
    const plan = this.plan();
    if ("missing" in plan) throw new Error(`vision locale indisponible : ${plan.missing}`);
    if (await this.supervisor.foreignOn(LOCAL_VISION_PORT)) return; // quelque chose répond déjà : on s'en sert, sans y toucher
    try {
      await this.supervisor.start({
        bin: plan.bin,
        model: plan.files.model,
        port: LOCAL_VISION_PORT,
        ctxSize: 8192,
        gpuLayers: 99,
        extraArgs: ["--mmproj", plan.files.mmproj, "--alias", LOCAL_VISION_MODEL, "--jinja", "--no-webui"],
      });
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as Error).message;
      throw new Error(`le modèle de vision n'a pas démarré : ${this.lastError}`);
    }
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.supervisor.stop(), IDLE_STOP_MS);
    this.idle.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    await this.supervisor.stop();
  }
}
