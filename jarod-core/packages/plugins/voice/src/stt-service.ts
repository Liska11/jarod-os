/**
 * Le serveur de dictée locale OpenVINO (`<racine Jarod-OS>/stt/server.py`, Whisper français distillé, compatible OpenAI sur 127.0.0.1:8790),
 * démarré et arrêté par Jarod (analyse du 30/10 : la dictée échouait en « fetch failed » parce que personne ne lançait de serveur).
 *
 * Même contrat que les autres superviseurs : spawn sans shell, 127.0.0.1 seulement, prêt quand `/health` dit `ok`, un serveur déjà présent
 * sur le port est ADOPTÉ (jamais tué), on n'arrête que ce qu'on a lancé. Le démarrage est partagé : dix dictées pendant le chargement du
 * modèle attendent le même démarrage au lieu d'en lancer dix.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpawnedProcess } from "@jarod/plugin-llm";

export const STT_PROVIDER_ID = "local-openvino-stt";
export const STT_DEFAULT_PORT = 8790;

export interface SttServerConfig {
  /** Le Python du venv du serveur. */
  python: string;
  /** `server.py`. */
  script: string;
  port: number;
}

export interface SttServiceDeps {
  spawn(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): SpawnedProcess;
  /** `GET <url>` → corps JSON, ou null si rien ne répond. */
  health(url: string, timeoutMs: number): Promise<{ status?: string } | null>;
  sleep?(ms: number): Promise<void>;
  /** Délai total accordé au chargement du modèle (défaut 180 s : le premier passage compile pour chaque appareil). */
  readyTimeoutMs?: number;
}

/**
 * Où est le serveur : `JAROD_STT_DIR`, sinon le dossier `stt` d'un parent du profil (D:\Jarod-OS\data\profile\profiles\default → D:\Jarod-OS\stt).
 * `null` quand rien n'est installé : la dictée le dira au lieu d'échouer en silence.
 */
export function findSttServer(profileDir: string, env: NodeJS.ProcessEnv = process.env, port = STT_DEFAULT_PORT): SttServerConfig | null {
  const candidates: string[] = [];
  if (env.JAROD_STT_DIR) candidates.push(env.JAROD_STT_DIR);
  let dir = profileDir;
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, "stt"));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of candidates) {
    const script = join(c, "server.py");
    const python = process.platform === "win32" ? join(c, "venv", "Scripts", "python.exe") : join(c, "venv", "bin", "python");
    if (existsSync(script) && existsSync(python)) return { python, script, port };
  }
  return null;
}

export class SttService {
  private child: SpawnedProcess | null = null;
  private starting: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly config: SttServerConfig | null,
    private readonly d: SttServiceDeps,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.config?.port ?? STT_DEFAULT_PORT}`;
  }

  status(): { installed: boolean; ownedPid: number | null; lastError: string | null } {
    return { installed: this.config !== null, ownedPid: this.child?.pid ?? null, lastError: this.lastError };
  }

  private async ready(timeoutMs = 2000): Promise<boolean> {
    return (await this.d.health(`${this.url}/health`, timeoutMs))?.status === "ok";
  }

  /** Prêt à transcrire : déjà en marche (le nôtre ou un autre), sinon lancé puis attendu. Lève avec une phrase lisible. */
  ensure(): Promise<void> {
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (await this.ready()) return;
    const cfg = this.config;
    if (!cfg) throw new Error("La dictée locale n'est pas installée : aucun serveur stt/server.py trouvé (dossier de Jarod-OS ou JAROD_STT_DIR).");
    if (!this.child) {
      const child = this.d.spawn(cfg.python, [cfg.script], { cwd: dirname(cfg.script), env: { ...process.env, STT_PORT: String(cfg.port), PYTHONIOENCODING: "utf-8" } });
      this.child = child;
      child.on("exit", (...args: unknown[]) => {
        const code = typeof args[0] === "number" ? args[0] : null;
        if (this.child === child) this.child = null;
        if (code) this.lastError = `le serveur de dictée s'est arrêté (code ${code})`;
      });
    }
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.d.readyTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (await this.ready()) {
        this.lastError = null;
        return;
      }
      if (!this.child) throw new Error(`La dictée locale n'a pas pu démarrer : ${this.lastError ?? "le serveur s'est arrêté aussitôt"}.`);
      await sleep(1000);
    }
    this.lastError = "délai de démarrage dépassé";
    throw new Error("La dictée locale met trop de temps à démarrer (chargement du modèle) : réessayez dans un instant.");
  }

  /** Arrête le serveur seulement s'il a été lancé ici ; un serveur adopté n'est jamais touché. */
  stop(): void {
    const c = this.child;
    this.child = null;
    if (c) c.kill();
  }
}
