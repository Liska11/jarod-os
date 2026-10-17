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
 */
import { AdapterRefused, AdapterUnavailable } from "./common.js";

export const UIA_OPS = ["list_windows", "find_element", "read_text", "click", "type_text", "focus_window", "press_key"] as const;
export type UiaOp = (typeof UIA_OPS)[number];
const READ_OPS = new Set<UiaOp>(["list_windows", "find_element", "read_text"]);

export interface WindowRef {
  /** Identifiant opaque rendu par le moteur. */
  id: string;
  title: string;
  process: string;
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
}

export interface UiaPolicy {
  /** Noms de processus permis (sans .exe, minuscules). Vide = rien n'est permis. */
  allowProcesses: string[];
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

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class UiaAutomation {
  private readonly calls: number[] = [];
  constructor(private readonly deps: UiaDeps) {}

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
    return p.allowProcesses.map((x) => x.toLowerCase()).includes(proc);
  }

  private async resolve(windowId: string): Promise<WindowRef> {
    const w = (await this.backend().listWindows()).find((x) => x.id === windowId);
    if (!w || !this.allowedWindow(w)) throw new AdapterRefused("D1/D2", "fenêtre absente ou non permise par la politique");
    return w;
  }

  private async run<T>(op: UiaOp, window: string | undefined, fn: () => Promise<T>, summary = ""): Promise<T> {
    try {
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
}
