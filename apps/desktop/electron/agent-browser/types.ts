/**
 * Le PORT du navigateur de l'agent (SPECS-P5-UI-PARITE.md §6) : ce que l'hôte fournit à plugin-tools pour que les outils `browser_*` existent.
 * Types seulement : plugin-tools (les outils) et le desktop (la fenêtre Electron isolée) s'y accordent sans dépendre l'un de l'autre.
 */
export interface BrowserElement {
  index: number;
  /** `a`, `button`, `input`, `textarea`, `select`… */
  tag: string;
  /** Type d'un champ (`text`, `password`, `checkbox`…), sinon vide. */
  type: string;
  label: string;
  /** Destination d'un lien, sinon vide. */
  href: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  /** Texte visible de la page. */
  text: string;
  elements: BrowserElement[];
}

/** Une seule page, isolée du profil de l'utilisateur. Chaque méthode peut lever (refus d'adresse, délai…). */
export interface BrowserPort {
  open(url: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
  read(signal?: AbortSignal): Promise<BrowserSnapshot>;
  click(index: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
  type(index: number, text: string, submit: boolean, signal?: AbortSignal): Promise<BrowserSnapshot>;
  /** Une touche du clavier (liste fermée : `BROWSER_KEYS`), envoyée à la page comme une vraie frappe. */
  press(key: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
  /** Fait défiler la page (déclenche les chargements paresseux). */
  scroll(direction: "down" | "up" | "top" | "bottom", signal?: AbortSignal): Promise<BrowserSnapshot>;
  /** Revient à la page précédente de l'historique. */
  back(signal?: AbortSignal): Promise<BrowserSnapshot>;
  /** Attend `seconds` (borné) ou, avec `text`, que ce texte apparaisse dans la page (au plus `seconds`). */
  wait(seconds: number, text?: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
  /** Montre la fenêtre à l'utilisateur MÊME si `browserVisible` est faux (passage de relais : connexion, captcha…). */
  reveal(): Promise<void>;
  close(): Promise<void>;
}

/** Les touches que l'agent peut presser : liste fermée (pas de combinaisons, pas de raccourcis système). */
export const BROWSER_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"] as const;
export type BrowserKey = (typeof BROWSER_KEYS)[number];
