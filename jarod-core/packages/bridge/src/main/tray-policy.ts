/**
 * Zone de notification (SPECS-P5-TRAY.md) : la LOGIQUE, sans Electron — fermer la fenêtre, le conseil d'une seule fois, le démarrage avec la session, le démarrage caché, le menu,
 * l'icône. `index.ts` branche ces fonctions sur la vraie fenêtre, le vrai `Tray` et le vrai système ; les tests les éprouvent sur des ports doublés.
 *
 * Invariants : quitter n'est JAMAIS empêché par le tray ; le réglage est lu AU MOMENT de la fermeture ; l'entrée de démarrage de la session n'est écrite que dans une version
 * empaquetée, jamais en développement ni par un test ; hors Windows, le comportement d'avant est gardé (la fermeture quitte).
 */
import { join } from "node:path";

/** L'argument que porte l'entrée de démarrage de la session : démarrer dans la zone de notification, sans montrer la fenêtre. */
export const HIDDEN_FLAG = "--hidden";

export interface CloseDeps {
  platform: NodeJS.Platform;
  /** Lu à CHAQUE fermeture (un changement vaut pour la fermeture suivante). */
  closeToTray(): boolean;
  /** Vrai dès qu'une sortie est en cours : « Quit », `app.quit()`, redémarrage, installation d'une mise à jour, fin de session. */
  quitting(): boolean;
  hintShown(): boolean;
  /** Écrit `trayHintShown` à vrai (par le MAIN, jamais par l'écran). */
  markHintShown(): void;
  /** Le ballon de la zone de notification. */
  showHint(): void;
  /**
   * Première fermeture cachée (`hintShown` faux) : la question « Rester dans la barre des tâches ? » (décision de l'utilisateur du 2026-10-05 :
   * `closeToTray = true` par défaut change la croix, donc le choix doit être VISIBLE). Absent (tests, mode test, pas de boîte native) : pas de
   * question, on cache et on montre le ballon comme avant. Une boîte annulée vaut « rester » (le choix non destructif).
   */
  askFirstClose?(): Promise<"stay" | "quit">;
  /** Réponse « quitter » : le choix est RETENU (`closeToTray` passe à faux) puis l'application quitte. */
  chooseQuit?(): void;
}

/** Fenêtres dont la question est déjà posée : une seconde croix pendant la boîte ne la repose pas. */
const asking = new WeakSet<object>();

/**
 * Le gestionnaire de l'événement `close` de la fenêtre. « hidden » : la fermeture est empêchée et la fenêtre cachée (jamais détruite) ; « closing » : elle suit son cours
 * (et, comme avant, quitte l'application quand c'est la dernière fenêtre).
 */
export function handleWindowClose(e: { preventDefault(): void }, win: { hide(): void; isDestroyed(): boolean }, d: CloseDeps): "hidden" | "closing" | "asking" {
  if (d.platform !== "win32" || d.quitting() || !d.closeToTray() || win.isDestroyed()) return "closing";
  e.preventDefault();
  if (!d.hintShown() && d.askFirstClose) {
    if (asking.has(win)) return "asking";
    asking.add(win);
    const done = (answer: "stay" | "quit" | null): void => {
      asking.delete(win);
      if (answer === "quit") {
        d.markHintShown();
        d.chooseQuit?.();
        return;
      }
      if (!win.isDestroyed()) win.hide();
      // « Rester » : la question vaut conseil, pas de ballon en plus. Boîte en erreur (null) : on cache sans rien retenir, la question reviendra.
      if (answer === "stay") d.markHintShown();
    };
    d.askFirstClose().then(done, () => done(null));
    return "asking";
  }
  win.hide();
  if (!d.hintShown()) {
    d.showHint();
    d.markHintShown();
  }
  return "hidden";
}

/** L'entrée de démarrage de la session, vue par un port : `packaged` faux = JAMAIS écrite. */
export interface LoginItemsPort {
  packaged: boolean;
  get(): boolean;
  set(on: boolean): void;
}

/** Pourquoi on ne peut PAS écrire l'entrée de démarrage, ou null. */
export function launchAtLoginRefusal(p: LoginItemsPort | undefined): string | null {
  if (!p) return "le démarrage avec la session est indisponible dans ce mode";
  if (!p.packaged) return "le démarrage avec la session n'existe que dans une version empaquetée de Jarod-One (jamais en développement)";
  return null;
}

/** Écrit (ou retire) l'entrée de démarrage de la session. Lève, sans appeler le système, hors version empaquetée. */
export function setLaunchAtLogin(p: LoginItemsPort | undefined, on: boolean): void {
  const refusal = launchAtLoginRefusal(p);
  if (refusal) throw new Error(`[oneai] ${refusal}`);
  p!.set(on);
}

/** Ce que l'écran affiche : l'état du SYSTÈME (pas le seul réglage) ; hors version empaquetée, faux et indisponible, sans lire le système. */
export function launchAtLoginView(p: LoginItemsPort | undefined): { value: boolean; available: boolean } {
  if (launchAtLoginRefusal(p)) return { value: false, available: false };
  return { value: p!.get(), available: true };
}

/** Démarrage par l'entrée de la session : la fenêtre n'est pas montrée. Un argument qui ne vaut pas exactement `--hidden` ne compte pas. */
export function startsHidden(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_FLAG);
}

/** Le menu du tray : DEUX entrées, rien d'autre. */
export function trayMenuItems(onShow: () => void, onQuit: () => void): { label: string; click: () => void }[] {
  return [
    { label: "Show Jarod-One", click: onShow },
    { label: "Quit", click: onQuit },
  ];
}

/** Le fichier d'icône du tray (un PNG à nous, sans la marque SANK-UI). */
export const trayIconPath = (resourcesDir: string): string => join(resourcesDir, "tray.png");

/** Le texte du ballon montré à la première fermeture cachée. */
export const TRAY_HINT = { title: "Jarod-One is still running", content: "Jarod-One keeps running in the notification area. Right-click the icon to quit." };
