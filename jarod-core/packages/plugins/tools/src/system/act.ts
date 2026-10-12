// Outils système, phase 2 (actions réversibles) : `system_state` (lecture : volume, mode sombre, écrans), `system_control` (volume, mode sombre,
// notification, veille des écrans), `system_open` (applications, adresses, fichiers, Réglages, éditeur) et `system_quit_app` (fermeture polie, ou
// de force). Portés de Herald OS (MIT, licenses/HERALD-OS.md) vers TypeScript. Windows seulement.
//
// Politique, différente de Herald : Jarod n'a pas de palier « act » silencieux. Tout outil qui AGIT est `dangerous` : un accord à chaque appel
// (l'utilisateur peut le lever par une règle `allow` ou l'approbation automatique) ; les lectures restent sans accord mais auditées. Ce que la
// politique interdit (chemin protégé, processus critique) est refusé par `precheck` AVANT toute demande d'accord, et la demande dit en une phrase ce
// qui va se passer. `lock_screen` n'est PAS exposé à l'agent (décision 5 du § 7 : verrouiller la session coupe l'utilisateur de sa machine).
// Deux écarts de sécurité, volontaires, par rapport à Herald :
//  - pas d'argument libre pour lancer un programme : un `app` de `system_open` ne reçoit jamais autre chose qu'un chemin existant ou une adresse
//    web, et ne peut pas être un interpréteur (cmd, powershell, wt, python…), sans quoi l'outil contournerait le garde du shell ;
//  - une adresse ne peut être que http(s) ou mailto (pas `file:`), un fichier exécutable ou un script n'est jamais « ouvert ».
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, win32 } from "node:path";
import type { ToolDef } from "../registry.js";
import { expandHome, protectedRoot, protectedRoots, realPathOrSelf } from "./disk.js";
import { type AppInfo, parseRunningApps, parseStartApps } from "./parse.js";
import { prepared } from "./prepared.js";
import { protectedReason, stopErrorMessage } from "./proc.js";
import { asList, powershellExe, type PsRunner, realPsRunner } from "./ps.js";
import * as A from "./scripts-act.js";
import * as S from "./scripts.js";
import type { SystemToolDeps } from "./tools.js";

/** Lance un programme détaché et rend la main dès qu'il a démarré. Remplaçable dans les tests. */
export type Launcher = (file: string, args: readonly string[], opts?: { verbatim?: boolean }) => Promise<void>;

export const realLauncher: Launcher = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { detached: true, stdio: "ignore", windowsVerbatimArguments: opts?.verbatim === true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

export interface SystemActDeps extends SystemToolDeps {
  launch?: Launcher;
  /** Des pid que `system_quit_app` ne fermera jamais, en plus du processus de Jarod et de son parent. */
  protectedPids?: readonly number[];
}

// --- listes -----------------------------------------------------------------------------------------------

/** Ouvrir ces types avec l'action par défaut les EXÉCUTERAIT au lieu de les montrer. */
export const EXECUTABLE_SUFFIXES = new Set([
  ".exe", ".com", ".scr", ".bat", ".cmd", ".msi", ".msp", ".msc", ".cpl", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".ps1", ".psm1", ".hta", ".reg",
  ".jar", ".dll", ".lnk", ".url", ".appref-ms", ".application", ".gadget",
]);

/** Des programmes qui exécutent ce qu'on leur passe : jamais choisis comme « application avec laquelle ouvrir » (ils contourneraient le garde du shell). */
export const INTERPRETERS = new Set([
  "cmd", "powershell", "powershell_ise", "pwsh", "wscript", "cscript", "mshta", "rundll32", "regsvr32", "msiexec", "wsl", "bash", "sh", "python", "pythonw", "py", "node",
  "deno", "bun", "ruby", "perl", "java", "javaw", "conhost", "wt", "windowsterminal", "mmc", "schtasks", "at", "sc", "reg", "regedit", "bitsadmin", "certutil", "forfiles",
]);

/** Les noms de volets de `ms-settings:` (repris de Herald). */
export const SETTINGS_PANES: Record<string, string> = {
  general: "about", about: "about", appearance: "personalization-colors", colors: "personalization-colors", accessibility: "easeofaccess", display: "display", displays: "display",
  wallpaper: "personalization-background", desktop_and_dock: "taskbar", taskbar: "taskbar", screen_saver: "lockscreen", lock_screen: "lockscreen", battery: "batterysaver",
  power: "powersleep", privacy: "privacy", privacy_and_security: "privacy", security: "windowsdefender", microphone: "privacy-microphone", camera: "privacy-webcam",
  location: "privacy-location", screen_recording: "privacy-graphicscaptureprogrammatic", users_and_groups: "yourinfo", passwords: "signinoptions", wifi: "network-wifi",
  bluetooth: "bluetooth", network: "network", notifications: "notifications", sound: "sound", focus: "quiethours", keyboard: "typing", mouse: "mousetouchpad",
  trackpad: "devices-touchpad", printers: "printers", software_update: "windowsupdate", storage: "storagesense", date_and_time: "dateandtime", login_items: "startupapps",
  apps: "appsfeatures", default_apps: "defaultapps",
};

// --- fonctions pures --------------------------------------------------------------------------------------

const squash = (s: string) => s.toLowerCase().replaceAll("&", "and").replace(/[^a-z0-9]/g, "");

/** Un nom de volet (« wifi », « Privacy & Security ») → la cible `ms-settings:`. Lève avec la liste si inconnu. */
export function resolvePane(pane: string): string {
  const key = squash(pane);
  const panes = Object.entries(SETTINGS_PANES).map(([name, value]) => [squash(name), value] as const);
  const exact = panes.find(([name]) => name === key);
  const partial = key ? panes.find(([name]) => name.includes(key)) : undefined;
  const found = exact ?? partial;
  if (!found) throw new Error(`Volet inconnu : « ${pane} ». Connus : ${Object.keys(SETTINGS_PANES).sort().join(", ")}`);
  return found[1];
}

export const isExecutablePath = (path: string): boolean => EXECUTABLE_SUFFIXES.has(extname(path).toLowerCase());

/** Le nom du programme sans dossier ni `.exe`, en minuscules : ce que compare la liste des interpréteurs. */
export const programStem = (path: string): string => basename(win32.basename(path), extname(path)).toLowerCase().replace(/\.exe$/, "");

/** `"level|muted"` pour le périphérique de lecture et de capture → la charge utile de `system_state`. */
export function parseAudio(data: Record<string, unknown>): { output_volume: number | null; input_volume: number | null; muted: boolean | null } {
  const split = (v: unknown): [number | null, boolean | null] => {
    const m = /^(\d+)\|([01])$/.exec(String(v ?? ""));
    return m ? [Number(m[1]), m[2] === "1"] : [null, null];
  };
  const [out, muted] = split(data.output);
  const [input] = split(data.input);
  return { output_volume: out, input_volume: input, muted };
}

export function parseAppearance(data: Record<string, unknown>): { dark_mode: boolean; displays: Record<string, unknown>[] } {
  const dark = data.apps_light;
  return {
    dark_mode: dark === null || dark === undefined ? false : Number(dark) === 0,
    displays: asList(data.screens).map((s) => ({ name: s.name, resolution: `${String(s.width)}x${String(s.height)}`, main: Boolean(s.primary) })),
  };
}

/** Une adresse web que l'outil accepte d'ouvrir : http, https ou mailto, sans espace ni guillemet. */
export function checkUrl(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("url est requis pour target=url");
  if (/[\s"<>]/.test(text)) throw new Error("L'adresse contient un espace ou un caractère interdit.");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Adresse invalide : ${text}`);
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) throw new Error("L'adresse doit commencer par http://, https:// ou mailto:");
  return text;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = args[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new Error(`${key} doit être l'un de : ${allowed.join(", ")}`);
  return v as T;
}

// --- les outils -------------------------------------------------------------------------------------------

const EDITORS: Record<string, { app: string; commands: string[] }> = {
  vscode: { app: "Visual Studio Code", commands: ["code"] },
  code: { app: "Visual Studio Code", commands: ["code"] },
  cursor: { app: "Cursor", commands: ["cursor"] },
  zed: { app: "Zed", commands: ["zed"] },
};
const AUTO_EDITORS = ["vscode", "cursor", "zed"] as const;

export function systemActTools(deps: SystemActDeps = {}): ToolDef[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return [];
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const launch = deps.launch ?? realLauncher;
  let ps: PsRunner | undefined = deps.ps;
  const runner = (): PsRunner => (ps ??= realPsRunner());
  const hasPs = () => deps.ps !== undefined || powershellExe(env) !== null;
  const roots = () => protectedRoots(env, home);
  const base = { source: "builtin" as const, audited: true, available: hasPs };
  const json = (v: unknown) => JSON.stringify(v);

  // Les applications du menu Démarrer, gardées 30 s (la lecture prend ≈ 0,6 s).
  let cache: { at: number; apps: AppInfo[] } | null = null;
  const installed = async (signal?: AbortSignal): Promise<AppInfo[]> => {
    if (cache && Date.now() - cache.at < 30_000) return cache.apps;
    const apps = parseStartApps(await runner().json(S.INSTALLED_APPS, undefined, { timeoutMs: 30_000, signal }));
    cache = { at: Date.now(), apps };
    return apps;
  };
  const findApp = async (name: string, signal?: AbortSignal): Promise<AppInfo | undefined> => {
    const needle = name.trim().toLowerCase().replace(/\.exe$/, "");
    const apps = await installed(signal);
    return apps.find((a) => a.name.toLowerCase() === needle) ?? apps.find((a) => a.name.toLowerCase().includes(needle) || (a.bundle_id ?? "").toLowerCase() === needle);
  };
  const isFile = async (p: string) => stat(p).then((s) => s.isFile(), () => false);
  /** Un nom nu (« notepad ») → son .exe par PATH puis « App Paths ». Un chemin ou un type de script est refusé : un nom ne devient pas une commande quelconque. */
  const commandPath = async (name: string, signal?: AbortSignal): Promise<string | null> => {
    const text = name.trim();
    if (!text || /[\\/:"<>|*?]/.test(text)) return null;
    const exeName = text.toLowerCase().endsWith(".exe") ? text : `${text}.exe`;
    for (const dir of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
      const candidate = join(dir, exeName);
      if (await isFile(candidate)) return candidate;
    }
    const row = (await runner().json(A.APP_PATH, { name: exeName }, { timeoutMs: 20_000, signal })) as { path?: string } | null;
    return row?.path ? row.path : null;
  };
  /** Le programme d'une application NOMMÉE par l'appelant, pour ouvrir quelque chose AVEC elle. Jamais un interpréteur. */
  const executableFor = async (name: string, hints: readonly string[] = [], signal?: AbortSignal): Promise<string> => {
    const app = await findApp(name, signal);
    let exe = app?.bundle_id && isAbsolute(app.bundle_id) && (await isFile(app.bundle_id)) ? app.bundle_id : null;
    for (const candidate of [name, ...hints]) {
      if (exe) break;
      exe = await commandPath(candidate, signal);
    }
    if (!exe) throw new Error(`Impossible d'ouvrir quoi que ce soit avec « ${name} » : ce n'est pas un programme installé qui prend un fichier ou une adresse.`);
    if (INTERPRETERS.has(programStem(exe))) throw new Error(`« ${name} » exécute ce qu'on lui passe (interpréteur de commandes) : il ne peut pas servir à ouvrir un fichier ou une adresse.`);
    return exe;
  };
  /** Un chemin de l'utilisateur : absolu après `~`, existant, hors des emplacements protégés (par le nom puis par le chemin réel). */
  const userPath = async (raw: string): Promise<string> => {
    if (!raw) throw new Error("path est requis");
    const path = expandHome(raw, home);
    if (!isAbsolute(path)) throw new Error(`Chemin non absolu : ${raw}. Donner un chemin complet ou ~.`);
    const hit = protectedRoot(path, roots()) ?? protectedRoot(realPathOrSelf(path), roots());
    if (hit) throw new Error(`${path} est dans l'emplacement protégé ${hit} : cet outil n'y touche pas.`);
    if (!(await stat(path).then(() => true, () => false))) throw new Error(`${path} n'existe pas`);
    return path;
  };

  const state: ToolDef = {
    ...base,
    name: "system_state",
    description: "Lit l'état des réglages de cet ordinateur : volume de sortie et d'entrée, son coupé ou non, mode sombre, écrans (résolution, principal). Lecture seule ; pour les changer, system_control.",
    parameters: { type: "object", properties: {} },
    async run(_args, ctx) {
      const opts = { timeoutMs: 30_000, signal: ctx.signal };
      const [audio, appearance] = await Promise.all([runner().json(A.AUDIO, undefined, opts), runner().json(A.APPEARANCE, undefined, opts)]);
      return json({ audio: parseAudio((audio ?? {}) as Record<string, unknown>), appearance: parseAppearance((appearance ?? {}) as Record<string, unknown>) });
    },
  };

  const control = prepared(
    {
      ...base,
      name: "system_control",
      dangerous: true,
      description: "Change un réglage de cet ordinateur (un accord est demandé à chaque fois). action=set_volume : percent (0-100) et/ou muted (vrai/faux) ; action=set_dark_mode : enabled (vrai/faux) ; action=notify : title (et body) en notification de bureau ; action=sleep_display : éteint les écrans (ils se rallument au premier mouvement). Rend l'état après le changement quand il existe. Le verrouillage de la session n'est pas disponible.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["set_volume", "set_dark_mode", "notify", "sleep_display"] },
          percent: { type: "integer", description: "Pour set_volume : 0 à 100." },
          muted: { type: "boolean", description: "Pour set_volume : couper ou rétablir le son." },
          enabled: { type: "boolean", description: "Pour set_dark_mode." },
          title: { type: "string", description: "Pour notify (120 caractères au plus)." },
          body: { type: "string", description: "Pour notify (400 caractères au plus)." },
        },
        required: ["action"],
      },
    },
    async (args, signal) => {
      const action = oneOf(args, "action", ["set_volume", "set_dark_mode", "notify", "sleep_display"] as const);
      const opts = { timeoutMs: 30_000, signal };
      if (action === "set_volume") {
        const set: Record<string, unknown> = {};
        if (args.percent !== undefined && args.percent !== null) {
          if (typeof args.percent !== "number" || !Number.isFinite(args.percent)) throw new Error("percent doit être un nombre");
          set.percent = Math.min(100, Math.max(0, Math.round(args.percent)));
        }
        if (args.muted !== undefined && args.muted !== null) {
          if (typeof args.muted !== "boolean") throw new Error("muted doit être vrai ou faux");
          set.muted = args.muted;
        }
        if (Object.keys(set).length === 0) throw new Error("set_volume demande percent et/ou muted");
        const what = [set.percent !== undefined ? `régler le volume à ${String(set.percent)} %` : "", set.muted === true ? "couper le son" : set.muted === false ? "rétablir le son" : ""].filter(Boolean).join(" et ");
        return { summary: `Sur cet ordinateur : ${what}`, go: async () => json({ audio: parseAudio(((await runner().json(A.AUDIO, set, opts)) ?? {}) as Record<string, unknown>) }) };
      }
      if (action === "set_dark_mode") {
        if (typeof args.enabled !== "boolean") throw new Error("enabled (vrai/faux) est requis pour set_dark_mode");
        const enabled = args.enabled;
        return {
          summary: `Sur cet ordinateur : ${enabled ? "activer" : "désactiver"} le mode sombre`,
          go: async () => {
            await runner().json(A.SET_DARK_MODE, { enabled }, opts);
            return json({ appearance: parseAppearance(((await runner().json(A.APPEARANCE, undefined, opts)) ?? {}) as Record<string, unknown>) });
          },
        };
      }
      if (action === "notify") {
        const title = str(args.title);
        if (!title) throw new Error("title est requis pour notify");
        return {
          summary: `Afficher une notification de bureau : « ${clip(title, 80)} »`,
          go: async () => {
            await runner().json(A.TOAST, { title: title.slice(0, 120), body: str(args.body).slice(0, 400) }, opts);
            return json({ notified: true });
          },
        };
      }
      return {
        summary: "Éteindre les écrans (ils se rallument au premier mouvement)",
        go: async () => {
          await runner().json(A.SLEEP_DISPLAY, undefined, opts);
          return json({ display: "asleep" });
        },
      };
    },
  );

  const open = prepared(
    {
      ...base,
      name: "system_open",
      dangerous: true,
      description: "Ouvre quelque chose pour l'utilisateur (un accord est demandé à chaque fois). target=app : lance une application par son nom (« Bloc-notes ») ; target=url : ouvre une adresse http(s) ou mailto dans le navigateur par défaut (ou dans l'application donnée) ; target=path : ouvre un fichier ou un dossier avec son application par défaut (ou celle donnée) — jamais un programme ou un script ; target=reveal : montre l'élément dans l'Explorateur ; target=editor : ouvre un dossier ou un fichier dans un éditeur de code (editor=auto prend le premier installé de VS Code, Cursor, Zed) ; target=settings : ouvre un volet des Paramètres Windows (pane=sound, wifi, display, privacy…).",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: ["app", "url", "path", "reveal", "editor", "settings"] },
          app: { type: "string", description: "Pour target=app : le nom ; pour url/path : l'application avec laquelle ouvrir (jamais un interpréteur de commandes)." },
          url: { type: "string" },
          path: { type: "string", description: "Chemin absolu ou ~. Les emplacements protégés sont refusés." },
          editor: { type: "string", description: "Pour target=editor : auto (défaut), vscode, cursor, zed." },
          pane: { type: "string", description: "Pour target=settings : le nom du volet." },
        },
        required: ["target"],
      },
    },
    async (args, signal) => {
      const target = oneOf(args, "target", ["app", "url", "path", "reveal", "editor", "settings"] as const);
      const appName = str(args.app);
      if (target === "app") {
        if (!appName) throw new Error("app est requis pour target=app");
        const found = await findApp(appName, signal);
        if (found) {
          return {
            summary: `Lancer l'application « ${found.name} »`,
            go: async () => {
              await launch("explorer.exe", [found.path]);
              return json({ opened: found.name });
            },
          };
        }
        const exe = await commandPath(appName, signal);
        if (!exe) throw new Error(`Application introuvable : « ${appName} »`);
        return {
          summary: `Lancer le programme ${exe}`,
          go: async () => {
            await launch(exe, []);
            return json({ opened: appName });
          },
        };
      }
      if (target === "settings") {
        const pane = str(args.pane) || "general";
        const resolved = resolvePane(pane);
        return {
          summary: `Ouvrir le volet « ${pane} » des Paramètres Windows`,
          go: async () => {
            await launch("explorer.exe", [`ms-settings:${resolved}`]);
            return json({ pane, opened: `ms-settings:${resolved}` });
          },
        };
      }
      if (target === "url") {
        const url = checkUrl(str(args.url));
        const exe = appName ? await executableFor(appName, [], signal) : null;
        return {
          summary: `Ouvrir ${clip(url, 160)}${appName ? ` dans ${appName}` : " dans le navigateur par défaut"}`,
          go: async () => {
            if (exe) await launch(exe, [url]);
            else await launch("explorer.exe", [url]);
            return json({ opened: url, app: appName || null });
          },
        };
      }
      const path = await userPath(str(args.path));
      if (target === "reveal") {
        return {
          summary: `Montrer ${path} dans l'Explorateur`,
          go: async () => {
            // `explorer /select,"<chemin>"` veut UNE ligne de commande ; un chemin Windows ne peut pas contenir de guillemet.
            await launch("explorer.exe", [`/select,"${path}"`], { verbatim: true });
            return json({ revealed: path });
          },
        };
      }
      if (target === "editor") {
        const requested = (str(args.editor) || "auto").toLowerCase();
        let chosen: { app: string; commands: string[] } | undefined;
        if (requested === "auto") {
          for (const key of AUTO_EDITORS) {
            const e = EDITORS[key]!;
            if ((await findApp(e.app, signal)) || (await commandPath(e.commands[0]!, signal))) {
              chosen = e;
              break;
            }
          }
          if (!chosen) throw new Error(`Aucun éditeur de code installé (cherché : ${AUTO_EDITORS.join(", ")}) ; nommer un éditeur avec editor=…`);
        } else chosen = EDITORS[requested] ?? { app: requested, commands: [] };
        const exe = await executableFor(chosen.app, chosen.commands, signal);
        const editor = chosen.app;
        return {
          summary: `Ouvrir ${path} dans ${editor}`,
          go: async () => {
            await launch(exe, [path]);
            return json({ opened: path, app: editor });
          },
        };
      }
      // target === "path"
      if (appName) {
        const exe = await executableFor(appName, [], signal);
        return {
          summary: `Ouvrir ${path} avec ${appName}`,
          go: async () => {
            await launch(exe, [path]);
            return json({ opened: path, app: appName });
          },
        };
      }
      if (isExecutablePath(path)) throw new Error(`${basename(path)} est un programme ou un script : l'ouvrir l'exécuterait. Nommer une application avec app=… pour l'ouvrir dedans.`);
      return {
        summary: `Ouvrir ${path} avec son application par défaut`,
        go: async () => {
          await launch("explorer.exe", [path]);
          return json({ opened: path, app: null });
        },
      };
    },
  );

  const quit = prepared(
    {
      ...base,
      name: "system_quit_app",
      dangerous: true,
      description: "Ferme une application (un accord est demandé à chaque fois). Par défaut poliment : sa fenêtre principale reçoit la demande de fermeture, l'application peut donc proposer d'enregistrer. Avec force=true elle est arrêtée net et le travail non enregistré est perdu. Refuse les processus du système, l'Explorateur et Jarod lui-même.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Le nom de l'application, tel que system_apps action=running le donne." },
          force: { type: "boolean", description: "Arrêt immédiat, sans demande de fermeture (travail non enregistré perdu)." },
        },
        required: ["name"],
      },
    },
    async (args, signal) => {
      const name = str(args.name);
      if (!name) throw new Error("name est requis");
      if (args.force !== undefined && args.force !== null && typeof args.force !== "boolean") throw new Error("force doit être vrai ou faux");
      const force = args.force === true;
      const opts = { timeoutMs: 30_000, signal };
      const running = parseRunningApps(await runner().json(S.RUNNING_APPS, undefined, opts));
      const app = await findApp(name, signal);
      const wanted = new Set([name.toLowerCase().replace(/\.exe$/, ""), ...(app ? [app.name.toLowerCase()] : [])]);
      if (app?.bundle_id?.toLowerCase().endsWith(".exe")) wanted.add(programStem(app.bundle_id));
      const targets = running.filter((r) => wanted.has(r.name.toLowerCase().replace(/\.exe$/, "")) || (r.path !== "" && wanted.has(programStem(r.path))));
      const label = app?.name ?? name;
      if (targets.length === 0) throw new Error(`${label} n'est pas ouverte`);
      const own = [process.pid, process.ppid, ...(deps.protectedPids ?? [])];
      for (const t of targets) {
        const why = protectedReason({ pid: t.pid, name: t.name, path: t.path }, own);
        if (why) throw new Error(`${t.name} : ${why} ; cet outil ne le ferme pas.`);
      }
      return {
        summary: `${force ? "Arrêter net (travail non enregistré perdu)" : "Fermer poliment"} ${label} (${targets.map((t) => `pid ${String(t.pid)}`).join(", ")})`,
        // Le pid ET le chemin du programme : un pid réattribué entre l'accord et l'exécution fait refuser l'exécution.
        fingerprint: `${force ? "force" : "polite"}|${targets.map((t) => `${String(t.pid)}:${t.path || t.name}`).join(",")}`,
        go: async () => {
          let closed = 0;
          const notes: string[] = [];
          for (const t of targets) {
            try {
              // Le nom du processus attendu (racine du programme) : le script refuse si le pid a été réattribué entre-temps.
              await runner().json(force ? A.FORCE_KILL : A.CLOSE_WINDOW, { pid: t.pid, name: t.path ? programStem(t.path) : "" }, { timeoutMs: 20_000, signal });
              closed += 1;
            } catch (e) {
              const raw = (e as Error).message;
              if (!/NOWINDOW|NOTFOUND|CHANGED|DENIED/.test(raw)) throw e;
              notes.push(`pid ${String(t.pid)} : ${stopErrorMessage(raw)}`);
            }
          }
          if (closed === 0) throw new Error(`${label} : ${notes.join(" ; ")}`);
          return json({ app: label, mode: force ? "force" : "polite", requested: closed, ...(notes.length ? { notes } : {}), note: force ? "Arrêtée." : "La fermeture est demandée ; l'application peut encore proposer d'enregistrer." });
        },
      };
    },
  );

  return [state, control, open, quit];
}
