/**
 * D1 (FlaUI, sidecar .NET) et D2 (pywinauto) — automatisation de l'interface Windows (UI Automation).
 *
 * Pouvoir fort : la gouvernance passe avant le branchement. Sept opérations sémantiques, jamais d'exécution
 * arbitraire, jamais de script ni de ligne de commande reçus d'un modèle. Politique appliquée AVANT le moteur :
 *  - une fenêtre cible doit correspondre à la liste blanche (processus) et ne pas correspondre à la liste noire
 *    (gestionnaires de mots de passe, invites d'élévation, sécurité Windows, paramètres de sécurité) ;
 *  - les lectures (list_windows, find_element, read_text) sont auditées ; les actions (click, type_text, focus_window,
 *    press_key) exigent l'accord de l'utilisateur à chaque appel ;
 *  - texte saisi borné, sans caractères de contrôle ; touches limitées à une liste ; débit limité ;
 *  - un champ de mot de passe n'est jamais lu ni rempli.
 * Les moteurs (FlaUI, pywinauto) implémentent `UiaBackend` : ils exécutent exactement ces opérations.
 *
 * Autonomie configurable (2026-10-21) : FlaUI ajoute le clavier (`press_keys` : combinaison ; `type_keys` : frappe brute dans la fenêtre au premier
 * plan) et la souris (`mouse_click`, `mouse_scroll` : coordonnées RELATIVES à la fenêtre). Le moteur constate que la fenêtre est au premier plan
 * avant toute touche et qu'un point de clic tombe sur elle. Les combinaisons qui agissent HORS de la fenêtre (touche Windows, Alt+Tab, Ctrl+Alt+…,
 * Ctrl+Échap, Ctrl+Maj+Échap) sont refusées ici. Sans `allowProcesses`, toute fenêtre hors de la liste noire est visible : ce sont alors les règles de
 * permissions (fenêtre = cible, opération) qui bornent ce que l'agent fait. Après un arrêt d'urgence (`emergencyStop`), tout est refusé jusqu'à
 * `resume()`.
 */
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export const UIA_OPS = ["list_windows", "find_element", "read_text", "click", "type_text", "focus_window", "press_key", "press_keys", "type_keys", "mouse_click", "mouse_scroll"] as const;
export type UiaOp = (typeof UIA_OPS)[number];
const READ_OPS = new Set<UiaOp>(["list_windows", "find_element", "read_text"]);

export interface WindowRef {
  /** Identifiant opaque rendu par le moteur. */
  id: string;
  title: string;
  process: string;
  /** Position et taille à l'écran (FlaUI) : les coordonnées d'un geste de souris sont relatives à son coin haut-gauche. */
  rect?: { left: number; top: number; width: number; height: number };
}

export interface ElementQuery {
  window: string;
  /** Nom accessible ou identifiant d'automatisation. */
  name?: string;
  automationId?: string;
  controlType?: "Button" | "Edit" | "Text" | "CheckBox" | "ComboBox" | "MenuItem" | "ListItem";
}

export interface ElementInfo {
  id: string;
  name: string;
  controlType: string;
  isPassword: boolean;
  /** Position relative au coin haut-gauche de la fenêtre (FlaUI) : pour viser l'élément par coordonnées. */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface UiaBackend {
  engine: "flaui" | "pywinauto";
  listWindows(): Promise<WindowRef[]>;
  findElement(query: ElementQuery): Promise<ElementInfo[]>;
  readText(window: string, element: string): Promise<string>;
  click(window: string, element: string): Promise<void>;
  typeText(window: string, element: string, text: string): Promise<void>;
  focusWindow(window: string): Promise<void>;
  pressKey(window: string, key: string): Promise<void>;
  /** Clavier et souris (FlaUI seulement) : absents = opération indisponible avec ce moteur. */
  pressKeys?(window: string, combo: string): Promise<void>;
  typeKeys?(window: string, text: string): Promise<void>;
  /** Rendent si le curseur a été constaté revenu à sa place (`restored`), quand le moteur le dit. */
  mouseClick?(window: string, x: number, y: number, button: "left" | "right" | "double"): Promise<{ restored?: boolean } | void>;
  mouseScroll?(window: string, x: number, y: number, amount: number): Promise<{ restored?: boolean } | void>;
}

/** Les combinaisons qui agissent hors de la fenêtre visée (système, autre fenêtre, sécurité) : refusées même accordées. */
export function systemComboReason(combo: string): string | null {
  const parts = combo.toLowerCase().split("+").map((x) => x.trim()).filter(Boolean);
  const key = parts.at(-1) ?? "";
  const mods = new Set(parts.slice(0, -1));
  if (parts.some((x) => x === "win" || x === "meta" || x === "super")) return "la touche Windows agit hors de la fenêtre";
  if (mods.has("ctrl") && mods.has("alt")) return "Ctrl+Alt+… est réservé au système (et Ctrl+Alt+Fin est l'arrêt d'urgence)";
  if (mods.has("alt") && (key === "tab" || key === "escape")) return "Alt+Tab et Alt+Échap changent de fenêtre";
  if (mods.has("ctrl") && key === "escape") return "Ctrl+Échap ouvre le menu Démarrer";
  return null;
}

export interface UiaPolicy {
  /** Noms de processus permis (sans .exe, minuscules). Vide = rien n'est permis ; absent = toute fenêtre hors de la liste noire (les règles bornent). */
  allowProcesses?: string[];
  denyProcesses?: string[];
  denyTitle?: RegExp;
  maxTextLength?: number;
  /** Appels maximum par fenêtre glissante d'une minute. */
  perMinute?: number;
  keys?: string[];
}

export const DEFAULT_DENY_PROCESSES = ["keepass", "keepassxc", "1password", "bitwarden", "lastpass", "dashlane", "consent", "securityhealthsystray", "windowsdefender", "mmc", "regedit", "taskmgr"];
export const DEFAULT_DENY_TITLE = /mot de passe|password|credential|identifiants|windows security|sécurité windows|contrôle de compte|user account control|uac/i;
const DEFAULT_KEYS = ["enter", "tab", "escape", "up", "down", "left", "right", "pageup", "pagedown", "home", "end"];

export interface UiaDeps {
  backend?: UiaBackend;
  policy: UiaPolicy;
  /** Accord de l'utilisateur pour une action ; refuse par défaut si absent. */
  approve?: (op: UiaOp, summary: string) => Promise<boolean>;
  audit?: (entry: { op: UiaOp; window?: string; ok: boolean; reason?: string }) => void;
  now?: () => number;
}

/** Le curseur constaté revenu (`true`), constaté ailleurs (`false`), ou non dit par le moteur (`null`). */
const restoredOf = (r: { restored?: boolean } | void): boolean | null => (r && typeof r.restored === "boolean" ? r.restored : null);

// biome-ignore lint/suspicious/noControlCharactersInRegex: intended, CONTROL rejects text that contains control characters
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class UiaAutomation {
  private readonly calls: number[] = [];
  private stoppedAt: number | null = null;
  constructor(private readonly deps: UiaDeps) {}

  /** Arrêt d'urgence : plus aucune opération, lecture comprise, jusqu'à `resume()`. */
  emergencyStop(now = Date.now()): void {
    this.stoppedAt ??= now;
  }

  /** L'instant de l'arrêt d'urgence en cours, ou null. */
  get stopped(): number | null {
    return this.stoppedAt;
  }

  /** Reprendre après un arrêt d'urgence : à n'appeler que sur une décision de l'utilisateur. */
  resume(): void {
    this.stoppedAt = null;
  }

  private backend(): UiaBackend {
    if (!this.deps.backend) throw new AdapterUnavailable("D1/D2", "aucun moteur UI Automation branché");
    return this.deps.backend;
  }

  private rate(): void {
    const now = (this.deps.now ?? Date.now)();
    while (this.calls.length && now - this.calls[0]! > 60_000) this.calls.shift();
    if (this.calls.length >= (this.deps.policy.perMinute ?? 30)) throw new AdapterRefused("D1/D2", "trop d'opérations à la minute");
    this.calls.push(now);
  }

  private allowedWindow(w: WindowRef): boolean {
    const p = this.deps.policy;
    const proc = w.process.toLowerCase().replace(/\.exe$/, "");
    const deny = new Set([...DEFAULT_DENY_PROCESSES, ...(p.denyProcesses ?? [])]);
    if (deny.has(proc)) return false;
    if ((p.denyTitle ?? DEFAULT_DENY_TITLE).test(w.title)) return false;
    if (p.allowProcesses === undefined) return true;
    return p.allowProcesses.map((x) => x.toLowerCase().replace(/\.exe$/, "")).includes(proc);
  }

  /** La fenêtre telle qu'elle est MAINTENANT, si elle est permise ; lève sinon. */
  async resolve(windowId: string): Promise<WindowRef> {
    const w = (await this.backend().listWindows()).find((x) => x.id === windowId);
    if (!w || !this.allowedWindow(w)) throw new AdapterRefused("D1/D2", "fenêtre absente ou non permise par la politique");
    return w;
  }

  private async run<T>(op: UiaOp, window: string | undefined, fn: () => Promise<T>, summary = ""): Promise<T> {
    try {
      if (this.stoppedAt !== null) throw new AdapterRefused("D1/D2", "arrêt d'urgence en cours : plus aucune opération sur le bureau avant reprise par l'utilisateur");
      this.rate();
      if (!READ_OPS.has(op)) {
        const ok = (await this.deps.approve?.(op, summary)) === true;
        if (!ok) throw new AdapterRefused("D1/D2", "action non accordée");
      }
      const out = await fn();
      this.deps.audit?.({ op, ...(window ? { window } : {}), ok: true });
      return out;
    } catch (e) {
      this.deps.audit?.({ op, ...(window ? { window } : {}), ok: false, reason: (e as Error).message.slice(0, 120) });
      throw e;
    }
  }

  /** Seules les fenêtres permises sont listées : le modèle ne voit pas le reste du bureau. */
  listWindows(): Promise<WindowRef[]> {
    return this.run("list_windows", undefined, async () => (await this.backend().listWindows()).filter((w) => this.allowedWindow(w)));
  }

  findElement(query: ElementQuery): Promise<ElementInfo[]> {
    return this.run("find_element", query.window, async () => {
      await this.resolve(query.window);
      if (!query.name && !query.automationId && !query.controlType) throw new AdapterRefused("D1/D2", "requête sans critère");
      return (await this.backend().findElement(query)).map((e) => (e.isPassword ? { ...e, name: "[champ protégé]" } : e));
    });
  }

  readText(window: string, element: string): Promise<string> {
    return this.run("read_text", window, async () => {
      await this.resolve(window);
      const info = (await this.backend().findElement({ window })).find((e) => e.id === element);
      if (info?.isPassword) throw new AdapterRefused("D1/D2", "un champ de mot de passe n'est jamais lu");
      return (await this.backend().readText(window, element)).slice(0, 20_000);
    });
  }

  click(window: string, element: string): Promise<void> {
    return this.run("click", window, async () => {
      await this.resolve(window);
      await this.backend().click(window, element);
    }, `cliquer sur ${element}`);
  }

  typeText(window: string, element: string, text: string): Promise<void> {
    const max = this.deps.policy.maxTextLength ?? 2000;
    return this.run("type_text", window, async () => {
      if (text.length > max) throw new AdapterRefused("D1/D2", `texte trop long (${text.length} > ${max})`);
      if (CONTROL.test(text)) throw new AdapterRefused("D1/D2", "caractères de contrôle refusés");
      await this.resolve(window);
      const info = (await this.backend().findElement({ window })).find((e) => e.id === element);
      if (info?.isPassword) throw new AdapterRefused("D1/D2", "un champ de mot de passe n'est jamais rempli");
      await this.backend().typeText(window, element, text);
    }, `saisir ${text.length} caractère(s) dans ${element}`);
  }

  focusWindow(window: string): Promise<void> {
    return this.run("focus_window", window, async () => {
      await this.resolve(window);
      await this.backend().focusWindow(window);
    }, `mettre ${window} au premier plan`);
  }

  pressKey(window: string, key: string): Promise<void> {
    const keys = this.deps.policy.keys ?? DEFAULT_KEYS;
    return this.run("press_key", window, async () => {
      if (!keys.includes(key.toLowerCase())) throw new AdapterRefused("D1/D2", `touche « ${key} » non permise`);
      await this.resolve(window);
      await this.backend().pressKey(window, key.toLowerCase());
    }, `appuyer sur ${key}`);
  }

  private need<K extends "pressKeys" | "typeKeys" | "mouseClick" | "mouseScroll">(k: K): NonNullable<UiaBackend[K]> {
    const b = this.backend();
    const f = b[k];
    if (!f) throw new AdapterUnavailable("D1/D2", `opération indisponible avec le moteur ${b.engine} (FlaUI seulement)`);
    return f.bind(b) as NonNullable<UiaBackend[K]>;
  }

  /** Une combinaison (« ctrl+s », « shift+tab », « f5 ») envoyée à la fenêtre, qui doit être au premier plan. */
  pressKeys(window: string, combo: string): Promise<void> {
    return this.run("press_keys", window, async () => {
      const c = combo.trim().toLowerCase();
      if (!/^([a-z]+\+){0,3}[a-z0-9]+$/.test(c)) throw new AdapterRefused("D1/D2", `combinaison illisible : « ${combo} »`);
      const sys = systemComboReason(c);
      if (sys) throw new AdapterRefused("D1/D2", `combinaison refusée : ${sys}`);
      await this.resolve(window);
      await this.need("pressKeys")(window, c);
    }, `appuyer sur ${combo}`);
  }

  /** Frappe brute dans la fenêtre au premier plan (là où se trouve le curseur de saisie), sans viser d'élément. */
  typeKeys(window: string, text: string): Promise<void> {
    const max = this.deps.policy.maxTextLength ?? 2000;
    return this.run("type_keys", window, async () => {
      if (!text) throw new AdapterRefused("D1/D2", "texte vide");
      if (text.length > max) throw new AdapterRefused("D1/D2", `texte trop long (${text.length} > ${max})`);
      if (CONTROL.test(text)) throw new AdapterRefused("D1/D2", "caractères de contrôle refusés");
      await this.resolve(window);
      await this.need("typeKeys")(window, text);
    }, `taper ${text.length} caractère(s) au clavier`);
  }

  private point(w: WindowRef, x: number, y: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) throw new AdapterRefused("D1/D2", "coordonnées : entiers positifs, relatifs au coin haut-gauche de la fenêtre");
    if (w.rect && (x >= w.rect.width || y >= w.rect.height)) throw new AdapterRefused("D1/D2", `point (${x}, ${y}) hors de la fenêtre (${w.rect.width} × ${w.rect.height})`);
  }

  /** Clic à des coordonnées RELATIVES à la fenêtre ; le moteur vérifie que le point tombe sur elle et remet le curseur en place. */
  mouseClick(window: string, x: number, y: number, button: "left" | "right" | "double" = "left"): Promise<boolean | null> {
    return this.run("mouse_click", window, async () => {
      if (!["left", "right", "double"].includes(button)) throw new AdapterRefused("D1/D2", "bouton : left, right ou double");
      this.point(await this.resolve(window), x, y);
      return restoredOf(await this.need("mouseClick")(window, x, y, button));
    }, `cliquer (${button}) en (${x}, ${y})`);
  }

  /** Défilement à des coordonnées relatives à la fenêtre ; `amount` > 0 vers le haut, borné à ±20 crans. */
  mouseScroll(window: string, x: number, y: number, amount: number): Promise<boolean | null> {
    return this.run("mouse_scroll", window, async () => {
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 20) throw new AdapterRefused("D1/D2", "amount : entier non nul entre -20 et 20");
      this.point(await this.resolve(window), x, y);
      return restoredOf(await this.need("mouseScroll")(window, x, y, amount));
    }, `défiler de ${amount} en (${x}, ${y})`);
  }
}
