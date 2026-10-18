// Portage de packages/core/src/services/plugins.ts (rév. 2e180305) — ISOLÉ par processus (U2, gap G6).
//
// La source chargeait chaque plugin dans le processus principal (`createRequire` :308, `activate` :372),
// avec les droits Node complets (gap-reel G6). Ici, même API publique (`list`, `reload`, `setEnabled`,
// `beforeSend`, `afterResponse`, `attachRouter`, `pageList`, `dataDirOf`, `unloadAll`, `seed`) et même
// `PluginApi` côté auteur, mais chaque plugin tourne dans SON processus (`runner.cjs`) :
// - `utilityProcess` sous Electron (fourni par le desktop), `child_process.fork` ailleurs ;
// - modèle de permissions de Node : lecture = runner + dossier du plugin, écriture = `<plugin>/data`,
//   aucun processus enfant, worker ni addon ; environnement vidé (aucun secret hérité) ;
// - permissions DÉCLARÉES dans `plugin.json` (`permissions`), fail-closed : absentes = aucune.
// Écarts consignés : `beforeSend` devient asynchrone (un appel inter-processus l'est) ; `service()` rend
// toujours null (un objet vivant ne traverse pas la frontière d'un processus).
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandContext, CommandRegistry, CommandResult } from "@jarod/plugin-agent";
import type { RouteHandler, RouteReply, Router } from "@jarod/plugin-llm";
import { Router as DefaultRouter } from "@jarod/plugin-llm";
import type { NotificationService, SettingsService } from "@jarod/plugin-storage";
import type { ToolContext, ToolDef, ToolRegistry } from "@jarod/plugin-tools";

/** Ce qu'un plugin peut déclarer. Toute autre valeur rend le manifeste invalide. */
export const PLUGIN_PERMISSIONS = ["tools", "commands", "hooks", "routes", "pages", "notify", "network"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  /** Surfaces et accès demandés (Jarod-cordis, G6). Absent = aucun : le plugin ne peut rien exposer. */
  permissions?: PluginPermission[];
}

export interface PluginInfo extends PluginManifest {
  enabled: boolean;
  state: "active" | "disabled" | "error";
  error?: string;
  tools: string[];
  /** Les routes que ce plugin a prises, et les pages qu'il déclare. */
  routes: string[];
  pages: string[];
  commands: string[];
  /** Permissions accordées (= déclarées) ; processus du plugin quand il tourne. */
  permissions: PluginPermission[];
  pid: number | null;
  /** Empreinte du CONTENU du plugin (fichiers hors `data/`) : la confiance de l'utilisateur lui est liée (Q19-4). */
  digest: string;
  /** Les outils de CE plugin que l'utilisateur a classés « sans accord » pour cette empreinte (noms enregistrés). */
  trusted: string[];
}

/** The contract a plugin's `activate(api)` receives (servi par `runner.cjs`, dans le processus du plugin). */
export interface PluginApi {
  readonly id: string;
  readonly dataDir: string;
  registerTool(def: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    /** Indication seulement (Q19-4) : l'accord est fixé par l'UTILISATEUR (`/plugin trust`) ; sans son classement, tout outil de plugin exige l'accord. */
    dangerous?: boolean;
    run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null }): Promise<string> | string;
  }): void;
  registerCommand(def: {
    name: string;
    description: string;
    usage?: string;
    run(args: string, ctx: CommandContext): Promise<CommandResult | string> | CommandResult | string;
  }): void;
  /** Transform the user's text before it is sent to the model. */
  onBeforeSend(fn: (text: string) => string | void): void;
  /** Observe each final assistant answer. */
  onAfterResponse(fn: (text: string, sessionId: string) => void): void;
  notify(title: string, body?: string): void;
  log(...args: unknown[]): void;
  /**
   * Expose une route HTTP sur 127.0.0.1, servie par le serveur d'écoute du cœur. Le chemin est tenu
   * par ce plugin seul, et retiré quand il se désactive.
   */
  registerRoute(method: string, path: string, handler: RouteHandler): void;
  /**
   * Déclare une page que l'application peut afficher. Le rendu est du texte : la page appartient au
   * plugin et l'application ne lui fait pas confiance pour autre chose que du contenu.
   */
  registerPage(def: { id: string; title: string; description?: string; render: () => string | Promise<string> }): void;
}

export interface PluginPage {
  pluginId: string;
  id: string;
  title: string;
  description: string;
  render: () => string | Promise<string>;
}

// ── Processus isolé ─────────────────────────────────────────────────────────────────────────────

/**
 * Empreinte du contenu d'un plugin : chemin et octets de tous ses fichiers, hors `data/` (que le plugin écrit lui-même).
 * Un lien ou un autre non-fichier compte par sa seule présence : changer de nature change l'empreinte.
 */
export async function digestOf(root: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (rel === "" && e.name === "data") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r);
      else if (e.isFile()) {
        h.update(`${r}\0`);
        h.update(await readFile(join(dir, e.name)));
        h.update("\0");
      } else h.update(`${r}\0non-fichier\0`);
    }
  };
  await walk(root, "");
  return h.digest("hex");
}

/** Un processus de plugin, vu de l'hôte : `utilityProcess` (Electron) et `ChildProcess` s'y ramènent. */
export interface IsolateProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(cb: (message: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export type IsolateSpawner = (
  runner: string,
  execArgv: string[],
  opts: { env: Record<string, string>; serviceName: string },
) => IsolateProcess;

/** `runner.cjs`, livré à côté de ce fichier (exécuté tel quel, sans compilation). */
export const RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), "runner.cjs");

/** Modèle de permissions de Node : le runner et le dossier du plugin en lecture, son `data/` en écriture. */
export function permissionArgs(
  runner: string,
  root: string,
  dataDir: string,
  permissions: readonly string[] = [],
  /** Le Node qui lancera le plugin connaît-il `--allow-net` ? (Node 25+ ; absent de Node 24 et d'Electron 44 : un drapeau inconnu tue le processus, code 9.) */
  hasAllowNet: boolean = process.allowedNodeEnvironmentFlags.has("--allow-net"),
): string[] {
  const args = ["--permission", `--allow-fs-read=${runner}`, `--allow-fs-read=${root}`, `--allow-fs-write=${dataDir}`];
  // Sans le drapeau (Node 24), le réseau n'est pas restreint par `--permission` : la garde réseau du runner (JS) reste la seule barrière.
  if (permissions.includes("network") && hasAllowNet) args.push("--allow-net");
  return args;
}

/** Environnement du plugin : rien de celui du cœur (jetons, clés) — le strict nécessaire à Windows. */
export function isolateEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["SystemRoot", "windir"]) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

/** Hors Electron (CLI, `jarod serve`, tests) : `child_process.fork`, canal IPC seul. */
export function forkSpawner(): IsolateSpawner {
  return (runner, execArgv, { env }) => {
    const child = fork(runner, [], {
      execArgv,
      // Sous Electron sans utilityProcess, l'exécutable est electron.exe : il doit se comporter en Node.
      env: process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (c: Buffer) => {
      stderr.push(c.toString("utf8"));
      if (stderr.length > 50) stderr.shift();
    });
    return {
      get pid() {
        return child.pid;
      },
      postMessage: (m) => void child.send(m as never),
      onMessage: (cb) => void child.on("message", cb),
      onExit: (cb) => void child.on("exit", (code) => cb(code)),
      kill: () => void child.kill(),
    };
  };
}

// ── Manifeste et modèle ─────────────────────────────────────────────────────────────────────────

export function validateManifest(value: unknown): PluginManifest {
  const m = value as Partial<PluginManifest> | null;
  if (!m || typeof m !== "object") throw new Error("plugin.json doit être un objet");
  if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(m.id))
    throw new Error("id invalide (minuscules, chiffres, tirets)");
  if (typeof m.name !== "string" || !m.name.trim()) throw new Error("name requis");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version))
    throw new Error("version semver requise (ex. 1.0.0)");
  if (typeof m.main !== "string" || !m.main) throw new Error("main requis");
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) throw new Error("permissions doit être une liste");
    const unknown = m.permissions.filter((p) => !(PLUGIN_PERMISSIONS as readonly string[]).includes(p as string));
    if (unknown.length) throw new Error(`permission inconnue : ${unknown.join(", ")} (connues : ${PLUGIN_PERMISSIONS.join(", ")})`);
  }
  return m as PluginManifest;
}

export const EXAMPLE_PLUGIN = {
  manifest: {
    id: "des",
    name: "Lanceur de dés",
    version: "1.0.0",
    description: "Exemple de plugin : une commande /roll et un outil roll_dice pour l'agent.",
    author: "Jarod-One",
    main: "index.js",
    // Jarod-cordis (G6) : le plugin tourne isolé et ne reçoit que ce qu'il déclare.
    permissions: ["commands", "tools", "routes", "pages"] as PluginPermission[],
  },
  code: `// Plugin d'exemple. Un plugin exporte activate(api) ; voir PluginApi dans @jarod/core.
function roll(spec) {
  const m = /^(\\d*)d(\\d+)$/i.exec(String(spec || "1d6").trim());
  if (!m) throw new Error("Format attendu : NdM, par ex. 2d6");
  const n = Math.min(Number(m[1] || 1), 100), faces = Math.min(Number(m[2]), 1000);
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * faces));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) };
}

exports.activate = (api) => {
  // Une route servie sur 127.0.0.1 : le plugin devient joignable de l exterieur.
  api.registerRoute("GET", "/des/:spec", ({ params }) => ({ body: roll(params.spec) }));
  // Une page que l application peut afficher.
  api.registerPage({
    id: "des",
    title: "Lanceur de des",
    render: () => "Exemple : " + JSON.stringify(roll("2d6")),
  });
  api.registerCommand({
    name: "roll",
    description: "Lance des dés (ex. /roll 2d6)",
    usage: "/roll 2d6",
    run: (args) => {
      const r = roll(args);
      return "🎲 " + r.rolls.join(" + ") + " = **" + r.total + "**";
    },
  });
  api.registerTool({
    name: "roll_dice",
    description: "Lance des dés au format NdM (ex. 3d20) et renvoie les résultats.",
    parameters: { type: "object", properties: { spec: { type: "string" } }, required: ["spec"] },
    run: (args) => JSON.stringify(roll(args.spec)),
  });
};
`,
};

// ── Hôte ────────────────────────────────────────────────────────────────────────────────────────

type Registration =
  | { kind: "tool"; name: string; description: string; parameters?: Record<string, unknown>; dangerous: boolean }
  | { kind: "command"; name: string; description: string; usage?: string }
  | { kind: "route"; method: string; path: string }
  | { kind: "page"; id: string; title: string; description?: string };

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

interface Loaded {
  info: PluginInfo;
  /** Le dossier du plugin (`<plugins>/<id>`) : `api.dataDir` en dérive, on ne le recalcule pas. */
  root: string;
  proc?: IsolateProcess;
  hooks: { beforeSend: boolean; afterResponse: boolean };
  pending: Map<number, Pending>;
  seq: number;
  /** Arrêt voulu (désactivation, rechargement) : la sortie du processus n'est pas une panne. */
  stopping: boolean;
  /** Messages d'une étape d'activation (`ready`, `activated`…), consommés dans l'ordre. */
  waiters: ((m: { t: string } & Record<string, unknown>) => boolean)[];
}

export interface IsolationOptions {
  /** Défaut : `forkSpawner()` ; le desktop passe `utilityProcess`. */
  spawn?: IsolateSpawner;
  runner?: string;
  /** Délai d'un appel (outil, commande, route, page, hook) ; défaut 60 s. */
  callTimeoutMs?: number;
  /** Délai de démarrage + `activate` ; défaut 15 s. */
  activateTimeoutMs?: number;
}

/**
 * Loads plugins from `<dataDir>/plugins/<id>/plugin.json`, each in its own isolated process (see the
 * header). `reload()` restarts them without restarting the app.
 */
export class PluginHost {
  private loaded = new Map<string, Loaded>();
  private readonly spawnIsolate: IsolateSpawner;
  private readonly runner: string;
  private readonly callTimeoutMs: number;
  private readonly activateTimeoutMs: number;

  constructor(
    readonly dir: string,
    private readonly tools: ToolRegistry,
    private readonly commands: CommandRegistry,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    isolation: IsolationOptions = {},
  ) {
    this.spawnIsolate = isolation.spawn ?? forkSpawner();
    this.runner = isolation.runner ?? RUNNER_PATH;
    this.callTimeoutMs = isolation.callTimeoutMs ?? 60_000;
    this.activateTimeoutMs = isolation.activateTimeoutMs ?? 15_000;
  }

  async seed(): Promise<void> {
    if (existsSync(this.dir)) return;
    const d = join(this.dir, EXAMPLE_PLUGIN.manifest.id);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "plugin.json"), JSON.stringify(EXAMPLE_PLUGIN.manifest, null, 2), "utf8");
    await writeFile(join(d, "index.js"), EXAMPLE_PLUGIN.code, "utf8");
  }

  list(): PluginInfo[] {
    return [...this.loaded.values()].map((l) => l.info).sort((a, b) => a.name.localeCompare(b.name));
  }

  async reload(): Promise<PluginInfo[]> {
    await this.unloadAll();
    await mkdir(this.dir, { recursive: true });
    const disabled = new Set(this.settings.get("disabledPlugins"));
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(this.dir, entry.name);
      const manifestPath = join(root, "plugin.json");
      if (!existsSync(manifestPath)) continue;
      let manifest: PluginManifest;
      try {
        manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      } catch (e) {
        const info: PluginInfo = {
          id: entry.name,
          name: entry.name,
          version: "?",
          main: "",
          enabled: false,
          state: "error",
          error: `Manifeste invalide : ${(e as Error).message}`,
          tools: [],
          routes: [],
          pages: [],
          commands: [],
          permissions: [],
          pid: null,
          digest: "",
          trusted: [],
        };
        this.loaded.set(entry.name, this.entry(info, root));
        continue;
      }
      const info: PluginInfo = {
        ...manifest,
        enabled: !disabled.has(manifest.id),
        state: "disabled",
        tools: [],
        routes: [],
        pages: [],
        commands: [],
        permissions: [...(manifest.permissions ?? [])],
        pid: null,
        digest: await digestOf(root),
        trusted: [],
      };
      this.dropStaleTrust(info);
      const loaded = this.entry(info, root);
      this.loaded.set(manifest.id, loaded);
      if (!info.enabled) continue;
      try {
        await this.activate(root, loaded);
        info.state = "active";
      } catch (e) {
        info.state = "error";
        info.error = (e as Error).message;
        this.removeContributions(manifest.id);
        await this.stop(loaded);
        this.notifications.add("error", `Plugin ${manifest.name} en erreur`, info.error);
      }
    }
    return this.list();
  }

  /** Vrai si l'utilisateur a classé cet outil « sans accord » POUR LE CONTENU ACTUEL du plugin. */
  private isTrusted(info: PluginInfo, toolName: string): boolean {
    const entry = this.settings.get("pluginTrust")[info.id];
    return Boolean(entry) && info.digest !== "" && entry!.digest === info.digest && entry!.tools.includes(toolName);
  }

  /** Un plugin dont le contenu a changé perd le classement de l'utilisateur, et il en est prévenu. */
  private dropStaleTrust(info: PluginInfo): void {
    const trust = this.settings.get("pluginTrust");
    const entry = trust[info.id];
    if (!entry || entry.digest === info.digest) return;
    const { [info.id]: _gone, ...rest } = trust;
    this.settings.set("pluginTrust", rest);
    this.notifications.add(
      "info",
      `Plugin « ${info.name} » modifié : confiance retirée`,
      `Son contenu a changé depuis que vous aviez classé ses outils « sans accord » (${entry.tools.join(", ")}) : ils demandent de nouveau votre accord à chaque appel. Pour les reclasser : /plugin trust ${info.id}`,
    );
  }

  /** Résout des noms d'outils (« roll_dice » ou « des_roll_dice ») en noms enregistrés du plugin ; aucun nom = tous. */
  private resolveTools(id: string, names: readonly string[]): { loaded: Loaded; tools: string[] } {
    const loaded = this.loaded.get(id);
    if (loaded?.info.state !== "active") throw new Error(`Plugin « ${id} » introuvable ou inactif.`);
    const prefix = `${id.replace(/-/g, "_")}_`;
    if (!names.length) return { loaded, tools: [...loaded.info.tools] };
    const tools = names.map((n) => {
      const hit = loaded.info.tools.find((t) => t === n || t === `${prefix}${n}`);
      if (!hit) throw new Error(`Outil inconnu du plugin « ${id} » : ${n} (outils : ${loaded.info.tools.join(", ") || "aucun"}).`);
      return hit;
    });
    return { loaded, tools };
  }

  /** Applique le classement courant aux outils déjà enregistrés (sans recharger le plugin). */
  private applyTrust(loaded: Loaded): void {
    loaded.info.trusted = loaded.info.tools.filter((n) => this.isTrusted(loaded.info, n));
    for (const n of loaded.info.tools) {
      const t = this.tools.get(n);
      if (t) t.dangerous = !loaded.info.trusted.includes(n);
    }
  }

  /**
   * Q19-4 — l'UTILISATEUR classe des outils du plugin « sans accord » (aucun nom : tous ses outils). Le classement vaut pour
   * l'empreinte ACTUELLE du contenu ; rend les noms enregistrés maintenant sans accord.
   */
  trustTools(id: string, names: readonly string[] = []): string[] {
    const { loaded, tools } = this.resolveTools(id, names);
    const trust = this.settings.get("pluginTrust");
    const kept = trust[id]?.digest === loaded.info.digest ? trust[id]!.tools : [];
    this.settings.set("pluginTrust", { ...trust, [id]: { digest: loaded.info.digest, tools: [...new Set([...kept, ...tools])].sort(), at: Date.now() } });
    this.applyTrust(loaded);
    return tools;
  }

  /** Retire le classement (aucun nom : tous les outils du plugin) : ils redemandent l'accord à chaque appel. */
  distrustTools(id: string, names: readonly string[] = []): string[] {
    const { loaded, tools } = this.resolveTools(id, names);
    const trust = this.settings.get("pluginTrust");
    const rest = (trust[id]?.digest === loaded.info.digest ? trust[id]!.tools : []).filter((t) => !tools.includes(t));
    const { [id]: _gone, ...others } = trust;
    this.settings.set("pluginTrust", rest.length ? { ...others, [id]: { digest: loaded.info.digest, tools: rest, at: Date.now() } } : others);
    this.applyTrust(loaded);
    return tools;
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
    const disabled = new Set(this.settings.get("disabledPlugins"));
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.settings.set("disabledPlugins", [...disabled]);
    return this.reload();
  }

  /** Chaque plugin actif qui a un `onBeforeSend` transforme le texte, dans l'ordre ; une panne est sautée. */
  async beforeSend(text: string): Promise<string> {
    let out = text;
    for (const l of this.loaded.values()) {
      if (l.info.state !== "active" || !l.hooks.beforeSend) continue;
      try {
        const r = await this.call(l, "beforeSend", "", out);
        if (typeof r === "string") out = r;
      } catch (e) {
        console.error(`[plugin ${l.info.id}] beforeSend`, e);
      }
    }
    return out;
  }

  afterResponse(text: string, sessionId: string): void {
    for (const l of this.loaded.values()) {
      if (l.info.state !== "active" || !l.hooks.afterResponse) continue;
      this.call(l, "afterResponse", "", { text, sessionId }).catch((e: unknown) => console.error(`[plugin ${l.info.id}] afterResponse`, e));
    }
  }

  /**
   * Le registre des routes. Tout hôte en a un : c'est une table en mémoire, et un seam qui n'existe
   * que si quelqu'un pense à le brancher est un seam qu'un auteur découvrira cassé. Le cœur passe
   * le sien, celui que le serveur d'écoute sert ; un hôte qui n'en passe pas garde ses routes
   * enregistrées mais non servies, et c'est à lui de le savoir.
   */
  private router: Router = new DefaultRouter();
  private readonly pages: PluginPage[] = [];

  /** Attache le serveur qui servira les routes. Sans lui, `registerRoute` le dit au lieu de mentir. */
  attachRouter(router: Router): void {
    this.router = router;
  }

  /** Les pages déclarées, tous plugins confondus. */
  pageList(): PluginPage[] {
    return [...this.pages];
  }

  /**
   * Source : le service qu'un plugin laisse sur son module chargé (`module.exports.__service`).
   * Isolé dans son processus, un plugin ne partage plus d'objet vivant avec le cœur : toujours null
   * (« pas de service », cas normal prévu par la source), jamais un objet d'un autre processus.
   */
  service<T = unknown>(_id: string): T | null {
    return null;
  }

  /** Le dossier que `api.dataDir` a donné au plugin (`<plugins>/<id>/data`), ou null s'il n'est pas chargé. */
  dataDirOf(id: string): string | null {
    const loaded = this.loaded.get(id);
    return loaded ? join(loaded.root, "data") : null;
  }

  private entry(info: PluginInfo, root: string): Loaded {
    return { info, root, hooks: { beforeSend: false, afterResponse: false }, pending: new Map(), seq: 0, stopping: false, waiters: [] };
  }

  /** Attend un message d'activation (ou la mort du processus, ou le délai). */
  private waitFor(l: Loaded, accept: (m: { t: string } & Record<string, unknown>) => boolean, what: string): Promise<{ t: string } & Record<string, unknown>> {
    return new Promise((resolveMsg, reject) => {
      const timer = setTimeout(() => {
        l.waiters = l.waiters.filter((w) => w !== waiter);
        reject(new Error(`PLUGIN_TIMEOUT: ${what} sans réponse en ${this.activateTimeoutMs} ms`));
      }, this.activateTimeoutMs);
      const waiter = (m: { t: string } & Record<string, unknown>) => {
        if (m.t === "<exit>") {
          clearTimeout(timer);
          reject(new Error(`processus du plugin arrêté pendant ${what} (code ${String(m.code)})${m.stderr ? ` : ${String(m.stderr).trim().split("\n").pop()}` : ""}`));
          return true;
        }
        if (!accept(m)) return false;
        clearTimeout(timer);
        resolveMsg(m);
        return true;
      };
      l.waiters.push(waiter);
    });
  }

  private async activate(root: string, loaded: Loaded): Promise<void> {
    const { info } = loaded;
    const mainPath = resolve(root, info.main);
    const rel = relative(root, mainPath);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("main doit rester dans le dossier du plugin");
    if (!existsSync(mainPath)) throw new Error(`module introuvable : ${info.main}`);
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });

    const proc = this.spawnIsolate(this.runner, permissionArgs(this.runner, root, dataDir, info.permissions), {
      env: isolateEnv(),
      serviceName: `Jarod plugin ${info.id}`,
    });
    loaded.proc = proc;
    info.pid = proc.pid ?? null;
    proc.onMessage((raw) => this.onMessage(loaded, raw));
    proc.onExit((code) => this.onExit(loaded, code));

    const ready = await this.waitFor(loaded, (m) => m.t === "ready", "le démarrage");
    if (typeof ready.pid === "number") info.pid = ready.pid;
    if (ready.permission !== true) throw new Error("le processus du plugin ne tourne pas sous le modèle de permissions de Node : refusé");
    proc.postMessage({ t: "activate", id: info.id, root, mainPath, dataDir, permissions: info.permissions });
    const done = await this.waitFor(loaded, (m) => m.t === "activated" || m.t === "activate-failed", "activate()");
    if (done.t === "activate-failed") throw new Error(String(done.error));
    loaded.hooks = done.hooks as Loaded["hooks"];
    for (const r of done.registrations as Registration[]) this.contribute(loaded, r);
  }

  /** Mêmes règles que la source (plugins.ts:318-370) ; l'exécution part au processus du plugin. */
  private contribute(loaded: Loaded, r: Registration): void {
    const { info } = loaded;
    if (r.kind === "tool") {
      const registered = `${info.id.replace(/-/g, "_")}_${r.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      // Q19-4 : l'accord est fixé par l'UTILISATEUR, pas par le plugin. Outil inconnu (jamais classé, ou contenu du plugin
      // modifié depuis) = dangereux ; ce que le plugin déclare n'est gardé que comme indication (`declaredDangerous`).
      const trusted = this.isTrusted(info, registered);
      if (trusted) info.trusted.push(registered);
      const tool: ToolDef & { pluginId: string; declaredDangerous: boolean } = {
        name: registered,
        description: `[Plugin ${info.name}] ${r.description}`,
        parameters: r.parameters ?? { type: "object", properties: {} },
        dangerous: !trusted,
        declaredDangerous: Boolean(r.dangerous),
        source: "plugin",
        run: async (args, ctx: ToolContext) =>
          String(await this.call(loaded, "tool", r.name, args, { sessionId: ctx.sessionId, workspace: ctx.workspace })),
        pluginId: info.id,
      };
      this.tools.register(tool);
      info.tools.push(tool.name);
    } else if (r.kind === "command") {
      if (this.commands.has(r.name) && !info.commands.includes(r.name)) {
        throw new Error(`La commande /${r.name} existe déjà`);
      }
      this.commands.register({
        name: r.name,
        description: r.description,
        ...(r.usage ? { usage: r.usage } : {}),
        source: "plugin",
        run: async (args: string, ctx: CommandContext) => (await this.call(loaded, "command", r.name, args, ctx)) as CommandResult,
        pluginId: info.id,
      } as Parameters<CommandRegistry["register"]>[0]);
      info.commands.push(r.name);
    } else if (r.kind === "route") {
      const key = `${r.method.toUpperCase()} ${r.path}`;
      this.router.register(info.id, r.method, r.path, async (request) => (await this.call(loaded, "route", key, request)) as RouteReply);
      // On retient ce que le plugin a pris : désactiver doit rendre la porte fermée.
      info.routes.push(key);
    } else {
      if (this.pages.some((page) => page.pluginId === info.id && page.id === r.id)) {
        throw new Error(`La page ${r.id} est déjà déclarée par ${info.id}`);
      }
      this.pages.push({
        pluginId: info.id,
        id: r.id,
        title: r.title,
        description: r.description ?? "",
        render: async () => String(await this.call(loaded, "page", r.id)),
      });
      info.pages.push(r.id);
    }
  }

  private call(l: Loaded, kind: string, name: string, args?: unknown, ctx?: unknown): Promise<unknown> {
    const proc = l.proc;
    if (!proc || l.info.state === "error") return Promise.reject(new Error(`plugin ${l.info.id} arrêté`));
    const seq = ++l.seq;
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => {
        l.pending.delete(seq);
        reject(new Error(`PLUGIN_TIMEOUT: ${l.info.id} n'a pas répondu en ${this.callTimeoutMs} ms (${kind} ${name})`));
      }, this.callTimeoutMs);
      l.pending.set(seq, { resolve: resolveCall, reject, timer });
      proc.postMessage({ t: "call", seq, kind, name, args, ctx });
    });
  }

  private onMessage(l: Loaded, raw: unknown): void {
    const m = raw as { t: string } & Record<string, unknown>;
    if (!m || typeof m.t !== "string") return;
    if (m.t === "result") {
      const p = l.pending.get(m.seq as number);
      if (!p) return;
      l.pending.delete(m.seq as number);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(String(m.error)));
    } else if (m.t === "notify") {
      this.notifications.add("info", String(m.title), String(m.body ?? ""));
    } else if (m.t === "log") {
      console.log(`[plugin ${l.info.id}]`, String(m.text));
    } else {
      const i = l.waiters.findIndex((w) => w(m));
      if (i >= 0) l.waiters.splice(i, 1);
    }
  }

  /** Processus mort : appels en cours rejetés ; hors arrêt voulu, c'est une panne dite (état, notification). */
  private onExit(l: Loaded, code: number | null): void {
    for (const w of [...l.waiters]) w({ t: "<exit>", code });
    l.waiters = [];
    for (const [, p] of l.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`plugin ${l.info.id} arrêté (code ${String(code)})`));
    }
    l.pending.clear();
    l.proc = undefined;
    l.info.pid = null;
    if (l.stopping || l.info.state !== "active") return;
    l.info.state = "error";
    l.info.error = `Le processus du plugin s'est arrêté (code ${String(code)})`;
    this.removeContributions(l.info.id);
    this.notifications.add("error", `Plugin ${l.info.name} arrêté`, l.info.error);
  }

  private removeContributions(id: string): void {
    // Une route qui survit serait une porte que l'utilisateur croit fermée. On retire aussi ses
    // pages : sans propriétaire pour les assumer, elles mentiraient sur ce qui est encore chargé.
    this.router?.unmount(id);
    for (let index = this.pages.length - 1; index >= 0; index -= 1) {
      if (this.pages[index]?.pluginId === id) this.pages.splice(index, 1);
    }
    this.tools.unregisterWhere((t) => (t as ToolDef & { pluginId?: string }).pluginId === id);
    this.commands.unregisterWhere((c) => (c as { pluginId?: string }).pluginId === id);
  }

  /** `deactivate()` du plugin (2 s au plus), puis fin du processus. */
  private async stop(l: Loaded): Promise<void> {
    const proc = l.proc;
    if (!proc) return;
    l.stopping = true;
    if (l.info.state === "active") {
      proc.postMessage({ t: "deactivate" });
      await Promise.race([this.waitFor(l, (m) => m.t === "deactivated", "deactivate()").catch(() => {}), new Promise((r) => setTimeout(r, 2_000))]);
    }
    const exited = new Promise<void>((r) => proc.onExit(() => r()));
    proc.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2_000))]);
  }

  async unloadAll(): Promise<void> {
    for (const l of this.loaded.values()) {
      try {
        await this.stop(l);
      } catch (e) {
        console.error(`[plugin ${l.info.id}] deactivate`, e);
      }
      this.removeContributions(l.info.id);
    }
    this.loaded.clear();
  }
}
