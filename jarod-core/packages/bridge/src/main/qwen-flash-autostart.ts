/**
 * Démarrage automatique de l'IA locale à l'ouverture du kernel du bureau :
 *   - whisper-server (dictée, CPU, port 8090) ;
 *   - le moteur LFM3-Omni sur CPU (port 8080) — seulement s'il n'y répond rien (le schéma existant `autoStartLocalEngine` passe d'abord) ;
 *   - Qwen3.8-Flash-Next dans WSL2 (port 30000) via `start-qwen-flash.ps1`, une fois le store (disque virtuel sur D:) monté (attente max 120 s).
 * Mêmes gardes que le moteur local : jamais en mode test ni sur un profil temporaire, échec non fatal et journalisé, annonce de l'état RÉEL.
 * Réglage hors base chiffrée : `<config>/qwen-flash.json` (à côté de `network-policy.json`) ; absent ou `autoStart` faux : rien ne démarre.
 * Whisper et LFM3 sont des processus FILS : ils s'arrêtent avec la passerelle (`stop()`). Qwen, lourd à relancer, reste actif (`start-qwen-flash.ps1 -Stop`).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engineAutoStartBlock } from "@jarod/plugin-llm";

export const QWEN_FLASH_URL = "http://127.0.0.1:30000/v1/models";
export const STORE_WAIT_DEFAULT_SEC = 120;

export interface WhisperCpuConfig {
  bin: string;
  model: string;
  port?: number;
  threads?: number;
  /** `-ac` : contexte audio de l'encodeur (768 ≈ 15 s d'audio, 1,7 s de latence ; absent = fenêtre de 30 s, 3,4 s). */
  audioCtx?: number;
  language?: string;
}
export interface LfmCpuConfig {
  bin: string;
  model: string;
  mmproj?: string;
  port?: number;
  ctx?: number;
  threads?: number;
}
export interface QwenFlashConfig {
  autoStart: boolean;
  launcher: string;
  distro?: string;
  /** Chemins (dans WSL) dont l'un doit exister pour que le store soit monté. */
  storePaths?: string[];
  storeWaitSec?: number;
  /**
   * Vrai : si le store n'est pas monté au lancement (après un redémarrage de Windows, le disque virtuel est détaché), le lanceur est rappelé avec
   * `-Remount`, ce qui affiche UNE invite UAC (WSL exige l'administrateur pour rattacher un disque). Refusée ou sans réponse : on attend puis on abandonne.
   * Absent ou faux : aucune invite, jamais.
   */
  remountPrompt?: boolean;
  whisper?: WhisperCpuConfig;
  lfm?: LfmCpuConfig;
}

/** Tout ce qui touche la machine, injectable pour les tests. */
export interface QwenFlashDeps {
  /** Une adresse HTTP répond-elle 200 ? */
  probe?: (url: string) => Promise<boolean>;
  /** Lance un service fils ; retourne son arrêt, ou une erreur lisible. */
  spawnChild?: (name: string, bin: string, args: string[]) => { stop: () => void } | { error: string };
  /** Lance le lanceur de Qwen (détaché) ; erreur lisible ou null. */
  launchQwen?: (launcher: string) => string | null;
  /** Le store est-il monté (vu depuis WSL) ? */
  storeMounted?: (cfg: QwenFlashConfig) => Promise<boolean>;
  /** Rattache le store (invite UAC) et rend quand c'est fini ; erreur lisible ou null. */
  remountStore?: (launcher: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
}

export interface QwenFlashHandle {
  stop(): void;
}

export function qwenFlashConfigPath(env: NodeJS.ProcessEnv): string {
  const dir = env.JAROD_OS_CONFIG_DIR?.trim() || join(env.APPDATA ?? "", "Jarod-OS", "config");
  return join(dir, "qwen-flash.json");
}

export function readQwenFlashConfig(env: NodeJS.ProcessEnv): QwenFlashConfig | null {
  const path = qwenFlashConfigPath(env);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<QwenFlashConfig>;
    return { ...raw, autoStart: raw.autoStart === true, launcher: typeof raw.launcher === "string" ? raw.launcher : "" };
  } catch {
    return null;
  }
}

/** Arguments de whisper-server : CPU seulement (`-ng`), français, route compatible OpenAI `/v1/audio/transcriptions`. */
export function whisperArgs(w: WhisperCpuConfig): string[] {
  const a = ["-m", w.model, "--host", "127.0.0.1", "--port", String(w.port ?? 8090), "-t", String(w.threads ?? 16), "-l", w.language ?? "fr", "-ng", "--inference-path", "/v1/audio/transcriptions"];
  if (w.audioCtx) a.push("-ac", String(w.audioCtx));
  return a;
}

/** Arguments de llama-server pour LFM3-Omni sur CPU (aucune couche GPU : la VRAM reste à Qwen). */
export function lfmArgs(l: LfmCpuConfig): string[] {
  const a = ["-m", l.model, "--host", "127.0.0.1", "--port", String(l.port ?? 8080), "-c", String(l.ctx ?? 4096), "-t", String(l.threads ?? 8), "-ngl", "0", "--jinja"];
  if (l.mmproj) a.push("--mmproj", l.mmproj, "--no-mmproj-offload");
  return a;
}

const defaultProbe = async (url: string): Promise<boolean> => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
};

const defaultSpawnChild = (_name: string, bin: string, args: string[]): { stop: () => void } | { error: string } => {
  if (!existsSync(bin)) return { error: `exécutable introuvable (${bin})` };
  try {
    const child: ChildProcess = spawn(bin, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    return { stop: () => void child.kill() };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 200) };
  }
};

const defaultLaunchQwen = (launcher: string): string | null => {
  if (process.platform !== "win32") return "WSL n'existe que sous Windows";
  if (!existsSync(launcher)) return `lanceur introuvable (${launcher})`;
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return null;
  } catch (e) {
    return (e as Error).message.slice(0, 200);
  }
};

/** `start-qwen-flash.ps1 -Remount` : l'invite UAC s'affiche à l'utilisateur ; 3 minutes pour répondre. */
const REMOUNT_TIMEOUT_MS = 180_000;
const defaultRemountStore = (launcher: string): Promise<string | null> =>
  new Promise((resolve) => {
    if (process.platform !== "win32") return resolve("WSL n'existe que sous Windows");
    if (!existsSync(launcher)) return resolve(`lanceur introuvable (${launcher})`);
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "-Remount"], { timeout: REMOUNT_TIMEOUT_MS, windowsHide: true }, (err) =>
      resolve(err ? "invite refusée, sans réponse ou échec du rattachement" : null),
    );
  });

const defaultStoreMounted =(cfg: QwenFlashConfig): Promise<boolean> =>
  new Promise((resolve) => {
    const paths = cfg.storePaths?.length ? cfg.storePaths : ["/mnt/wsl/lqfstore/qwen.bin", "/mnt/lqfstore/qwen.bin"];
    const test = paths.map((p) => `test -f '${p.replaceAll("'", "")}'`).join(" || ");
    execFile("wsl.exe", ["-d", cfg.distro ?? "Ubuntu-24.04", "-e", "sh", "-c", test], { timeout: 20_000, windowsHide: true }, (err) => resolve(!err));
  });

/** Lance (ou refuse de lancer) l'IA locale et journalise ; ne rejette JAMAIS. Rend une poignée dont `stop()` arrête les services fils. */
export async function autoStartQwenFlash(
  dataRoot: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  tmpRoot?: string,
  deps: QwenFlashDeps = {},
): Promise<QwenFlashHandle> {
  const children: { stop: () => void }[] = [];
  const handle: QwenFlashHandle = { stop: () => children.splice(0).forEach((c) => c.stop()) };
  try {
    const cfg = readQwenFlashConfig(env);
    if (!cfg?.autoStart) return handle;
    const block = engineAutoStartBlock(dataRoot, env, tmpRoot);
    if (block) {
      log(`IA locale : non démarrée — le démarrage automatique est activé mais ignoré (${block})`);
      return handle;
    }
    const probe = deps.probe ?? defaultProbe;
    const spawnChild = deps.spawnChild ?? defaultSpawnChild;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const child = async (name: string, probeUrl: string, port: number, bin: string, args: string[]): Promise<void> => {
      try {
        if (await probe(probeUrl)) return log(`${name} : déjà actif (port ${port})`);
        const r = spawnChild(name, bin, args);
        if ("error" in r) return log(`${name} : démarrage abandonné — ${r.error}`);
        children.push(r);
        log(`${name} : démarrage lancé (port ${port})`);
      } catch (e) {
        log(`${name} : démarrage abandonné — ${(e as Error).message.slice(0, 200)}`);
      }
    };

    const qwen = async (): Promise<void> => {
      try {
        if (await probe(QWEN_FLASH_URL)) return log("Qwen Flash : déjà actif (port 30000)");
        const mounted = deps.storeMounted ?? defaultStoreMounted;
        const limit = (cfg.storeWaitSec ?? STORE_WAIT_DEFAULT_SEC) * 1000;
        let waited = 0;
        if (cfg.remountPrompt === true && !(await mounted(cfg))) {
          log("Qwen Flash : le store n'est pas monté — demande de rattachement (invite UAC à accepter)");
          const refused = await (deps.remountStore ?? defaultRemountStore)(cfg.launcher);
          log(refused ? `Qwen Flash : rattachement non fait — ${refused}` : "Qwen Flash : store rattaché");
        }
        while (!(await mounted(cfg))) {
          if (waited >= limit) return log(`Qwen Flash : abandonné — le store n'est pas monté après ${limit / 1000} s (service de montage du disque virtuel de D: ?)`);
          await sleep(5_000);
          waited += 5_000;
        }
        const failure = (deps.launchQwen ?? defaultLaunchQwen)(cfg.launcher);
        log(failure ? `Qwen Flash : démarrage abandonné — ${failure}` : "Qwen Flash : démarrage lancé (WSL + serveur, ~1 min ; port 30000)");
      } catch (e) {
        log(`Qwen Flash : démarrage abandonné — ${(e as Error).message.slice(0, 200)}`);
      }
    };

    const jobs: Promise<void>[] = [];
    if (cfg.whisper) jobs.push(child("Whisper", `http://127.0.0.1:${cfg.whisper.port ?? 8090}/`, cfg.whisper.port ?? 8090, cfg.whisper.bin, whisperArgs(cfg.whisper)));
    if (cfg.lfm) jobs.push(child("LFM3-Omni", `http://127.0.0.1:${cfg.lfm.port ?? 8080}/health`, cfg.lfm.port ?? 8080, cfg.lfm.bin, lfmArgs(cfg.lfm)));
    if (cfg.launcher) jobs.push(qwen());
    await Promise.all(jobs);
  } catch (e) {
    log(`IA locale : démarrage automatique abandonné — ${(e as Error).message.slice(0, 300)}`);
  }
  return handle;
}
