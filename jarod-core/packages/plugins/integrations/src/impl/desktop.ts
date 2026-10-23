/**
 * D1 raccordé (2026-10-21) : le pilote de fenêtres FlaUI devient deux outils de l'agent, sous les permissions configurables.
 *
 *  - `desktop_windows` (lecture, auditée, sans accord) : les fenêtres visibles hors de la liste noire (gestionnaires de mots de passe, invites
 *    d'élévation, sécurité Windows), avec leur CIBLE de règle — `processus:titre`, par exemple `notepad.exe:Sans titre - Bloc-notes`.
 *  - `desktop_control` (sensible : accord à chaque appel, sauf règle autonome) : lire un élément, cliquer, saisir, mettre au premier plan, touches,
 *    et — opérations RÉSERVÉES, refusées sans règle de l'utilisateur — clavier brut et souris par coordonnées. La fenêtre est la cible de la règle,
 *    l'action son opération (`read.*`, `ui.*`, `keyboard.*`, `mouse.*`) :
 *      jarod permissions add auto desktop_control --cible "notepad.exe:*" --operation "keyboard.*" --duree 1h
 *  - Un seul contrôleur actif par bureau (`DesktopLease`, commun à tous les processus Jarod de la session).
 *  - Arrêt d'urgence : Ctrl+Alt+Fin au clavier physique (lu par le moteur), ou l'annulation de la tâche (écran Tâches, Échap) qui arrête le moteur
 *    en pleine opération. Après Ctrl+Alt+Fin, plus rien ne passe ; l'appel suivant demande à l'utilisateur de REPRENDRE, même sous une règle autonome.
 *  - Ce que le moteur constate au moment d'agir : fenêtre au premier plan avant toute touche, point de clic sur la fenêtre visée (pas sur une
 *    fenêtre qui la recouvre), curseur remis à sa place. Un champ de mot de passe n'est jamais lu ni rempli.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AdapterRefused } from "./common.js";
import { DesktopLease } from "./desktop-lease.js";
import { childLineProcess, SidecarUiaBackend } from "./uia-sidecar.js";
import { type ElementQuery, UiaAutomation, type WindowRef } from "./uia.js";

/** Où trouver le moteur FlaUI : JAROD_FLAUI_WORKER, sinon JAROD_ENGINES_DIR\flaui\uia-flaui-worker.exe. */
export function flauiWorker(env: Record<string, string | undefined> = process.env): string | null {
  const c = [env.JAROD_FLAUI_WORKER, env.JAROD_ENGINES_DIR && join(env.JAROD_ENGINES_DIR, "flaui", "uia-flaui-worker.exe")].filter((x): x is string => Boolean(x));
  return c.find((p) => existsSync(p)) ?? null;
}

/** L'opération de règle de chaque action : `read.*` lit, `ui.*` agit sur un élément, `keyboard.*` et `mouse.*` sont le clavier brut et la souris. */
export const DESKTOP_OPERATIONS: Record<string, string> = {
  find_element: "read.find_element",
  read_text: "read.read_text",
  click: "ui.click",
  type_text: "ui.type_text",
  focus_window: "ui.focus_window",
  press_key: "ui.press_key",
  press_keys: "keyboard.press_keys",
  type_keys: "keyboard.type_keys",
  mouse_click: "mouse.click",
  mouse_scroll: "mouse.scroll",
};

/** Les opérations que l'agent n'a qu'avec une règle de l'utilisateur qui les couvre (fenêtre et opération). */
export const DESKTOP_RESERVED: Readonly<Record<string, string>> = {
  "keyboard.press_keys": "une combinaison de touches peut déclencher n'importe quelle commande de l'application (enregistrer, fermer, supprimer…)",
  "keyboard.type_keys": "la frappe brute va là où se trouve le curseur de saisie, sans viser d'élément",
  "mouse.click": "un clic par coordonnées vise un point de l'écran, pas un élément nommé",
  "mouse.scroll": "le défilement par coordonnées vise un point de l'écran",
};

/** La cible d'une fenêtre pour les règles : `processus:titre`. */
export const windowTarget = (w: WindowRef): string => `${w.process.toLowerCase()}:${w.title}`;

export interface DesktopDeps {
  worker: () => string | null;
  /** Fabrique du moteur (tests : un moteur factice). */
  backend?: () => SidecarUiaBackend;
  lease?: DesktopLease;
  idleMs?: number;
}

/**
 * Les processus de Jarod-OS (sans .exe, minuscules) : l'exécutable du shell (`JAROD_SHELL_EXE`, posé par le shell au lancement du cœur) et
 * celui de ce processus (le cœur tourne sous l'exécutable du shell dans le paquet). Leurs fenêtres ne sont jamais pilotées par l'agent.
 */
export function ownProcesses(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string[] {
  const names = [env.JAROD_SHELL_EXE, execPath.split(/[\\/]/).pop()]
    .filter((n): n is string => typeof n === "string" && n.trim() !== "")
    .map((n) => n.trim().toLowerCase().replace(/\.exe$/, ""));
  return [...new Set(names)];
}

/** Le moteur, son bail et son état d'urgence, partagés par les deux outils d'un même processus. */
export class DesktopController {
  private backend: SidecarUiaBackend | null = null;
  private uia: UiaAutomation | null = null;
  private readonly known = new Map<string, WindowRef>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private emergency: number | null = null;
  readonly lease: DesktopLease;

  constructor(private readonly deps: DesktopDeps) {
    this.lease = deps.lease ?? new DesktopLease();
  }

  available(): boolean {
    return process.platform === "win32" && (this.deps.backend !== undefined || this.deps.worker() !== null);
  }

  private engine(): UiaAutomation {
    if (this.uia) return this.uia;
    const b =
      this.deps.backend?.() ??
      new SidecarUiaBackend(
        "flaui",
        () => {
          const w = this.deps.worker();
          if (!w) throw new AdapterRefused("D1", "moteur FlaUI introuvable (JAROD_FLAUI_WORKER ou JAROD_ENGINES_DIR)");
          return childLineProcess(w, [], { DOTNET_ROOT: process.env.DOTNET_ROOT ?? "C:\\Program Files\\dotnet", ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files" });
        },
        30_000,
      );
    b.onEmergency = () => this.emergencyStop();
    this.backend = b;
    // La politique de la gouvernance commune : liste noire, débit, textes bornés. Pas de liste blanche : ce sont les règles qui bornent ; pas
    // d'accord ici : la porte de l'agent l'a déjà demandé (ou une règle autonome en a dispensé).
    // Jamais les fenêtres de Jarod-OS lui-même (réglages, confirmations natives) : l'agent pourrait y cliquer pour s'accorder des droits.
    this.uia = new UiaAutomation({ backend: b, policy: { perMinute: 120, maxTextLength: 4000, denyProcesses: ownProcesses() }, approve: async () => true });
    if (this.emergency !== null) this.uia.emergencyStop(this.emergency);
    return this.uia;
  }

  /** Arrêt d'urgence : le moteur est arrêté net, le bail rendu ; rien ne passe avant une reprise décidée par l'utilisateur. */
  emergencyStop(now = Date.now()): void {
    this.emergency ??= now;
    this.uia?.emergencyStop(now);
    this.shutdown();
  }

  get stopped(): number | null {
    return this.emergency;
  }

  resume(): void {
    this.emergency = null;
    this.uia?.resume();
  }

  /** Arrête le moteur (en pleine opération s'il le faut) et rend le bail. */
  shutdown(): void {
    clearTimeout(this.idle);
    this.backend?.close();
    this.lease.release();
  }

  dispose(): void {
    this.shutdown();
    this.backend = null;
    this.uia = null;
  }

  /** La fenêtre déjà vue (liste) : sert à dire la cible d'un appel sans attendre le moteur. */
  knownTarget(id: unknown): string | undefined {
    const w = typeof id === "string" ? this.known.get(id) : undefined;
    return w ? windowTarget(w) : undefined;
  }

  async listWindows(): Promise<WindowRef[]> {
    const list = await this.engine().listWindows();
    for (const w of list) this.known.set(w.id, w);
    this.touch();
    return list;
  }

  /** La fenêtre telle qu'elle est maintenant ; refuse si elle n'est plus celle que la cible annoncée désignait. */
  async live(id: string): Promise<WindowRef> {
    const w = await this.engine().resolve(id);
    const was = this.knownTarget(id);
    this.known.set(id, w);
    if (was !== undefined && was !== windowTarget(w)) throw new AdapterRefused("D1", `la fenêtre ${id} a changé (« ${was} » → « ${windowTarget(w)} ») ; relister les fenêtres`);
    return w;
  }

  /** Une opération de pilotage, sous le bail de cette conversation ; l'annulation de la tâche arrête le moteur en pleine opération. */
  async control<T>(session: string, signal: AbortSignal | undefined, fn: (uia: UiaAutomation) => Promise<T>): Promise<T> {
    this.lease.acquire(session);
    const uia = this.engine();
    const abort = () => this.shutdown();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fn(uia);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.touch(session);
    }
  }

  /** Activité : le bail est renouvelé, et rendu (moteur arrêté) après l'inactivité. */
  private touch(session?: string): void {
    if (session !== undefined && this.lease.holder()) this.lease.acquire(session);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.shutdown(), this.deps.idleMs ?? 120_000);
    this.idle.unref?.();
  }
}

/** La forme d'un `ToolDef` de plugin-tools (sans en dépendre). */
interface Ctx {
  sessionId: string;
  workspace: string | null;
  signal?: AbortSignal;
  approve?: (sessionId: string, call: { id: string; name: string; args: Record<string, unknown> }, description: string) => Promise<boolean>;
}
export interface DesktopToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  dangerous: boolean;
  audited: true;
  source: "builtin";
  available(): boolean;
  targetOf?(args: Record<string, unknown>): string | undefined;
  operationOf?(args: Record<string, unknown>): string | undefined;
  restrictedOperations?: Readonly<Record<string, string>>;
  precheck?(args: Record<string, unknown>, ctx: Ctx): Promise<string | void>;
  run(args: Record<string, unknown>, ctx: Ctx): Promise<string>;
}

/** Ce que le moteur a constaté du curseur après un geste de souris. */
const cursorNote = (restored: boolean | null): string =>
  restored === true ? " (curseur remis en place)." : restored === false ? " (curseur déplacé pendant le geste, sans doute par l'utilisateur : non remis)." : ".";
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new AdapterRefused("D1", `${what} : entier requis`);
  return v;
};

export function desktopTools(c: DesktopController): DesktopToolDef[] {
  const windows: DesktopToolDef = {
    name: "desktop_windows",
    description:
      "Liste les fenêtres ouvertes de ce bureau Windows (identifiant, titre, processus, position et taille), hors gestionnaires de mots de passe, invites d'élévation et sécurité Windows. Chaque fenêtre porte sa cible de règle (processus:titre). Lecture seule, auditée. À appeler avant desktop_control.",
    parameters: { type: "object", properties: {} },
    dangerous: false,
    audited: true,
    source: "builtin",
    available: () => c.available(),
    async run() {
      if (c.stopped !== null) return "Arrêt d'urgence en cours (Ctrl+Alt+Fin) : le prochain appel de desktop_control demandera à l'utilisateur de reprendre.";
      const list = await c.listWindows();
      return JSON.stringify(list.map((w) => ({ id: w.id, title: w.title, process: w.process, rect: w.rect, target: windowTarget(w) })));
    },
  };

  const describe = (a: Record<string, unknown>, w: WindowRef): string => {
    const where = `« ${w.title} » (${w.process})`;
    switch (a.action) {
      case "find_element":
        return `Chercher des éléments dans ${where}`;
      case "read_text":
        return `Lire l'élément ${str(a.element)} de ${where}`;
      case "click":
        return `Cliquer sur l'élément ${str(a.element)} de ${where}`;
      case "type_text":
        return `Saisir ${str(a.text).length} caractère(s) dans l'élément ${str(a.element)} de ${where}`;
      case "focus_window":
        return `Mettre ${where} au premier plan`;
      case "press_key":
        return `Appuyer sur ${str(a.key)} dans ${where}`;
      case "press_keys":
        return `Combinaison ${str(a.combo)} dans ${where}`;
      case "type_keys":
        return `Taper ${str(a.text).length} caractère(s) au clavier dans ${where}`;
      case "mouse_click":
        return `Clic ${str(a.button) || "left"} en (${String(a.x)}, ${String(a.y)}) dans ${where}`;
      case "mouse_scroll":
        return `Défiler de ${String(a.amount)} en (${String(a.x)}, ${String(a.y)}) dans ${where}`;
      default:
        throw new AdapterRefused("D1", `action inconnue : ${String(a.action)}`);
    }
  };

  const control: DesktopToolDef = {
    name: "desktop_control",
    description:
      "Pilote une fenêtre de ce bureau Windows (FlaUI). Actions sur un élément nommé : find_element (name, automationId, controlType), read_text, click, type_text (element, text), focus_window, press_key (enter, tab, escape, flèches, pageup/pagedown, home, end). Clavier brut et souris (opérations réservées, refusées sans règle de l'utilisateur) : press_keys (combo, ex. ctrl+s), type_keys (text), mouse_click (x, y relatifs au coin haut-gauche de la fenêtre ; button left/right/double), mouse_scroll (x, y, amount ±20). Un accord est demandé à chaque appel sauf règle autonome pour cette fenêtre et cette opération. Un seul contrôleur à la fois ; l'utilisateur peut tout arrêter par Ctrl+Alt+Fin. Jamais de champ de mot de passe.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: Object.keys(DESKTOP_OPERATIONS) },
        window: { type: "string", description: "Identifiant rendu par desktop_windows." },
        element: { type: "string", description: "Identifiant rendu par find_element." },
        name: { type: "string" },
        automationId: { type: "string" },
        controlType: { type: "string", enum: ["Button", "Edit", "Text", "CheckBox", "ComboBox", "MenuItem", "ListItem"] },
        text: { type: "string" },
        key: { type: "string" },
        combo: { type: "string", description: "ex. ctrl+s, shift+tab, f5" },
        x: { type: "integer" },
        y: { type: "integer" },
        button: { type: "string", enum: ["left", "right", "double"] },
        amount: { type: "integer" },
      },
      required: ["action", "window"],
    },
    dangerous: true,
    audited: true,
    source: "builtin",
    available: () => c.available(),
    targetOf: (args) => c.knownTarget(args.window),
    operationOf: (args) => DESKTOP_OPERATIONS[str(args.action)],
    restrictedOperations: DESKTOP_RESERVED,
    async precheck(args) {
      if (!Object.hasOwn(DESKTOP_OPERATIONS, str(args.action))) throw new AdapterRefused("D1", `action inconnue : ${String(args.action)}`);
      // Après un arrêt d'urgence, le moteur est arrêté : la demande dit la reprise, la cible reste celle déjà vue.
      if (c.stopped !== null) return `REPRENDRE après l'arrêt d'urgence, puis : ${str(args.action)} dans ${c.knownTarget(args.window) ?? str(args.window)}`;
      return describe(args, await c.live(str(args.window)));
    },
    async run(args, ctx) {
      if (c.stopped !== null) {
        // La reprise est une décision de l'UTILISATEUR, demandée même sous une règle autonome ; sans porte d'accord, refus.
        const ok = (await ctx.approve?.(ctx.sessionId, { id: `reprise-${Date.now()}`, name: "desktop_control", args: { reprise: true } }, "Reprendre le pilotage du bureau après l'arrêt d'urgence (Ctrl+Alt+Fin) ?")) === true;
        if (!ok) return "Refusé : arrêt d'urgence en cours, la reprise n'a pas été accordée par l'utilisateur.";
        c.resume();
      }
      const win = str(args.window);
      return c.control(ctx.sessionId, ctx.signal, async (uia) => {
        await c.live(win);
        switch (args.action) {
          case "find_element": {
            const q: ElementQuery = { window: win, ...(str(args.name) ? { name: str(args.name) } : {}), ...(str(args.automationId) ? { automationId: str(args.automationId) } : {}), ...(str(args.controlType) ? { controlType: str(args.controlType) as ElementQuery["controlType"] } : {}) };
            return JSON.stringify((await uia.findElement(q)).slice(0, 200));
          }
          case "read_text":
            return await uia.readText(win, str(args.element));
          case "click":
            await uia.click(win, str(args.element));
            return "Clic fait.";
          case "type_text":
            await uia.typeText(win, str(args.element), str(args.text));
            return "Saisie faite.";
          case "focus_window":
            await uia.focusWindow(win);
            return "Fenêtre au premier plan.";
          case "press_key":
            await uia.pressKey(win, str(args.key));
            return "Touche envoyée.";
          case "press_keys":
            await uia.pressKeys(win, str(args.combo));
            return "Combinaison envoyée.";
          case "type_keys":
            await uia.typeKeys(win, str(args.text));
            return "Texte tapé.";
          case "mouse_click":
            return `Clic fait${cursorNote(await uia.mouseClick(win, int(args.x, "x"), int(args.y, "y"), (str(args.button) || "left") as "left" | "right" | "double"))}`;
          case "mouse_scroll":
            return `Défilement fait${cursorNote(await uia.mouseScroll(win, int(args.x, "x"), int(args.y, "y"), int(args.amount, "amount")))}`;
          default:
            throw new AdapterRefused("D1", `action inconnue : ${String(args.action)}`);
        }
      });
    },
  };
  return [windows, control];
}
