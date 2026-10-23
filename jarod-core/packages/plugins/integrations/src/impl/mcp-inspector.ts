/**
 * G9 — MCP Inspector (modelcontextprotocol/inspector), OUTIL DE DÉVELOPPEMENT lancé à la demande, jamais au démarrage de Jarod.
 *
 * Ce que l'adaptateur impose (mesuré sur Inspector 2.9.0) :
 *  - écoute en BOUCLAGE seulement (`HOST=127.0.0.1`), ports vérifiés libres AVANT le lancement : un port occupé par un autre programme
 *    est une erreur, jamais une raison de l'arrêter ;
 *  - authentification OBLIGATOIRE : jeton aléatoire propre à l'instance (`MCP_INSPECTOR_API_TOKEN`), `DANGEROUSLY_OMIT_AUTH` retiré ;
 *    le jeton n'entre ni dans l'URL rendue ni dans la sortie gardée (masqué) ;
 *  - aucune écriture dans le profil de l'utilisateur : secrets en MÉMOIRE (`MCP_INSPECTOR_SECRET_STORE=memory`, sinon Inspector écrit
 *    dans le trousseau Windows), stockage, catalogue et journal dans un dossier temporaire supprimé à l'arrêt ;
 *  - environnement MINIMAL transmis (jamais celui du noyau entier : pas de clé de fournisseur ni de valeur du coffre) ;
 *  - le serveur MCP à inspecter passe par un fichier de configuration (`--config` / `--server`), jamais par des arguments que le
 *    lanceur réinterprète (`-e` y est une option d'Inspector) ;
 *  - ouverture automatique du navigateur coupée ; `stop()` n'arrête que le processus lancé ici et son arbre.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export const INSPECTOR_LAUNCHER = join("node_modules", "@modelcontextprotocol", "inspector", "clients", "launcher", "build", "index.js");

export interface InspectorServer {
  name: string;
  command: string;
  args?: string[];
  /** Variables pour le serveur inspecté seulement (jamais héritées du noyau). */
  env?: Record<string, string>;
  /** Dossier de travail du serveur (chemins relatifs de ses arguments) ; défaut : le dossier temporaire de l'instance. */
  cwd?: string;
}

export interface InspectorOptions {
  /** Dossier du moteur (`engines/mcp-inspector`). */
  engineDir: string;
  node?: string;
  server?: InspectorServer;
  port?: number;
  sandboxPort?: number;
  startTimeoutMs?: number;
}

export interface InspectorInstance {
  /** URL de l'interface, SANS jeton. */
  url: string;
  /** Jeton de session (éphémère) : à saisir dans l'interface ; jamais journalisé par Jarod. */
  token: string;
  pid: number;
  /** Sortie du processus, jeton masqué. */
  output(): string;
  stop(): Promise<void>;
}

const ENV_KEEP = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "TEMP", "TMP", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];

/** L'environnement d'une instance : minimal, profil et stockage redirigés dans son dossier temporaire, secrets en mémoire. */
function isolatedEnv(work: string, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return Object.assign(env, {
    MCP_AUTO_OPEN_ENABLED: "false",
    MCP_INSPECTOR_SECRET_STORE: "memory",
    MCP_STORAGE_DIR: join(work, "storage"),
    MCP_LOG_FILE: join(work, "inspector.log"),
    USERPROFILE: work,
    HOME: work,
    APPDATA: join(work, "appdata"),
    LOCALAPPDATA: join(work, "localappdata"),
    DO_NOT_TRACK: "1",
    ...extra,
  });
}

/** Le serveur inspecté, par un fichier de configuration en lecture seule (jamais par des arguments réinterprétés). */
function serverArgs(work: string, server: InspectorServer | undefined): string[] {
  if (!server) return [];
  if (!/^[\w.-]{1,64}$/.test(server.name)) throw new AdapterRefused("G9", "nom de serveur invalide");
  const config = join(work, "servers.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { [server.name]: { type: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? {}, ...(server.cwd ? { cwd: server.cwd } : {}) } } }));
  return ["--config", config, "--server", server.name];
}

export type InspectorListMethod = "tools/list" | "resources/list" | "prompts/list";

/**
 * Mode ligne de commande d'Inspector : une LECTURE du catalogue d'un serveur (outils, ressources ou invites), en JSON. Aucune méthode
 * d'appel (`tools/call`…) n'est offerte ici : appeler un outil passe par la porte unique de Jarod, pas par l'outil de développement.
 */
export async function inspectorList(o: { engineDir: string; node?: string; server: InspectorServer; method: InspectorListMethod; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
  const launcher = join(o.engineDir, INSPECTOR_LAUNCHER);
  if (!existsSync(launcher)) throw new AdapterUnavailable("G9", `MCP Inspector introuvable (${launcher})`);
  if (!["tools/list", "resources/list", "prompts/list"].includes(o.method)) throw new AdapterRefused("G9", `méthode non permise : ${o.method}`);
  const work = mkdtempSync(join(tmpdir(), "jarod-mcp-inspector-"));
  try {
    const args = [launcher, "--cli", ...serverArgs(work, o.server), "--method", o.method];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        o.node ?? process.execPath,
        args,
        { cwd: work, env: isolatedEnv(work, {}), windowsHide: true, timeout: o.timeoutMs ?? 30_000, maxBuffer: 4 * 1024 * 1024, ...(o.signal ? { signal: o.signal } : {}) },
        (err, out, errOut) => {
          if (err) {
            if ((err as Error).name === "AbortError") return reject(new AdapterRefused("G9", "inspection annulée"));
            return reject(new AdapterUnavailable("G9", `inspection impossible : ${String(errOut || (err as Error).message).slice(0, 600)}`));
          }
          resolve(out);
        },
      );
    });
    try {
      return JSON.parse(stdout);
    } catch {
      throw new AdapterUnavailable("G9", "sortie d'Inspector illisible (JSON attendu)");
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ host: "127.0.0.1", port, exclusive: true }, () => s.close(() => resolve(true)));
  });
}

/** Arrête un processus ET son arbre, par son pid (le nôtre seulement). */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) return resolve();
    const done = () => resolve();
    child.once("exit", done);
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => setTimeout(done, 2000));
    else {
      child.kill("SIGTERM");
      setTimeout(done, 2000);
    }
  });
}

export async function startInspector(o: InspectorOptions): Promise<InspectorInstance> {
  const launcher = join(o.engineDir, INSPECTOR_LAUNCHER);
  if (!existsSync(launcher)) throw new AdapterUnavailable("G9", `MCP Inspector introuvable (${launcher}) : voir engines.lock/README.md`);
  const port = o.port ?? 6274;
  const sandboxPort = o.sandboxPort ?? port + 1;
  for (const p of [port, sandboxPort]) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new AdapterRefused("G9", `port invalide : ${p}`);
    if (!(await portFree(p))) throw new AdapterRefused("G9", `le port ${p} est déjà utilisé par un autre programme ; Jarod ne l'arrête pas`);
  }
  const token = randomBytes(24).toString("hex");
  const work = mkdtempSync(join(tmpdir(), "jarod-mcp-inspector-"));
  const args = [launcher, "--web", ...serverArgs(work, o.server)];
  const env = isolatedEnv(work, {
    HOST: "127.0.0.1",
    CLIENT_PORT: String(port),
    MCP_SANDBOX_PORT: String(sandboxPort),
    MCP_INSPECTOR_API_TOKEN: token,
    // Catalogue modifiable seulement sans serveur imposé : `--config` (lecture seule) et le catalogue s'excluent (Inspector 2.9.0).
    ...(o.server ? {} : { MCP_CATALOG_PATH: join(work, "catalog.json") }),
  });
  const child = spawn(o.node ?? process.execPath, args, { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const keep = (d: Buffer) => {
    out = (out + d.toString("utf8")).slice(-32_000);
  };
  child.stdout!.on("data", keep);
  child.stderr!.on("data", keep);
  const masked = () => out.split(token).join("[jeton]");
  const cleanup = () => rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const stop = async () => {
    await killTree(child);
    try {
      cleanup();
    } catch {
      // un fichier encore verrouillé par Windows : le dossier temporaire sera repris par le système
    }
  };

  const deadline = Date.now() + (o.startTimeoutMs ?? 30_000);
  const url = `http://127.0.0.1:${port}/`;
  for (;;) {
    if (child.exitCode !== null) {
      await stop();
      throw new AdapterUnavailable("G9", `MCP Inspector s'est arrêté au démarrage (code ${child.exitCode}) : ${masked().slice(-600)}`);
    }
    try {
      const r = await fetch(`${url}api/config`, { headers: { "x-mcp-remote-auth": `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {
      // pas encore prêt
    }
    if (Date.now() > deadline) {
      await stop();
      throw new AdapterUnavailable("G9", "MCP Inspector n'a pas répondu dans le délai");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { url, token, pid: child.pid!, output: masked, stop };
}
