/**
 * V-19 — routage par capacité. Le disjoncteur (`RoutingService`) choisit entre des candidats DÉCLARÉS selon leur santé ; il ne sait pas
 * ce que le tour demande. Ici, une politique déclarée par la personne (`capabilityRouting` : un modèle pour la vision, un pour le code,
 * un pour le long contexte — chacun facultatif) et une détection de ce que CE tour demande :
 *
 * - **vision** : une image est jointe à ce tour et le modèle actif ne voit pas les images ;
 * - **long contexte** : l'historique estimé dépasse 80 % de la fenêtre connue du modèle actif (fenêtre inconnue : jamais) ;
 * - **code** : le message porte des signes nets de code (bloc ```, trace d'appels, fichier source, mots du métier).
 *
 * Priorité dans cet ordre : une image que le modèle ne peut pas voir est un empêchement, une fenêtre trop petite aussi ; le code n'est
 * qu'une préférence. Le modèle de la route passe EN TÊTE de la chaîne, les replis déclarés restent derrière (rien ne part chez un
 * fournisseur que la personne n'a pas nommé). Une conversation dont le modèle est épinglé n'est jamais re-routée. Pur, sans E/S.
 */

export type Capability = "vision" | "code" | "longContext";

export interface CapabilityRoute {
  provider: string;
  model: string;
}

export type CapabilityRoutes = Partial<Record<Capability, CapabilityRoute>>;

export interface TurnNeeds {
  /** Le texte du message de ce tour. */
  text: string;
  /** Une image est jointe à ce tour. */
  hasImage: boolean;
  /** Le modèle actif voit les images. */
  activeSeesImages: boolean;
  /** Jetons estimés de l'historique envoyé (système compris). */
  historyTokens: number;
  /** Fenêtre du modèle actif, en jetons ; 0 = inconnue. */
  activeWindow: number;
}

export interface CapabilityChoice {
  capability: Capability;
  route: CapabilityRoute;
  reason: string;
}

/** Au-delà de cette part de la fenêtre, le tour est « long contexte ». */
export const LONG_CONTEXT_SHARE = 0.8;

const CODE_SIGNS: RegExp[] = [
  /```/,
  /^\s+at .+\(.+:\d+:\d+\)\s*$/m,
  /Traceback \(most recent call last\)/,
  /\b[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|sql|ps1|sh)\b/i,
  /\b(?:refactor\w*|compil\w*|stack ?trace|traceback|regex|typescript|javascript|python|rust|golang|segfault|nullpointer|undefined is not)\b/i,
];

/** Le message porte-t-il des signes nets de code ? */
export const looksLikeCode = (text: string): boolean => CODE_SIGNS.some((re) => re.test(text));

const valid = (r: CapabilityRoute | undefined): r is CapabilityRoute => Boolean(r && typeof r.provider === "string" && r.provider && typeof r.model === "string" && r.model);

/** Ce que ce tour demande, et la route déclarée qui y répond ; `null` = rien à changer (aucune route, ou aucun besoin). */
export function chooseCapability(needs: TurnNeeds, routes: CapabilityRoutes | undefined, pinned = false): CapabilityChoice | null {
  if (pinned || !routes) return null;
  if (needs.hasImage && !needs.activeSeesImages && valid(routes.vision))
    return { capability: "vision", route: routes.vision, reason: "une image est jointe et le modèle actif ne voit pas les images" };
  if (needs.activeWindow > 0 && needs.historyTokens > needs.activeWindow * LONG_CONTEXT_SHARE && valid(routes.longContext))
    return {
      capability: "longContext",
      route: routes.longContext,
      reason: `l'historique (~${needs.historyTokens} jetons) dépasse 80 % de la fenêtre du modèle actif (${needs.activeWindow})`,
    };
  if (valid(routes.code) && looksLikeCode(needs.text)) return { capability: "code", route: routes.code, reason: "le message porte du code" };
  return null;
}

/** La chaîne de candidats avec la route en tête (sans la répéter plus loin). */
export function withRoute<T extends { provider: string; model: string }>(chain: T[], route: CapabilityRoute): (T | CapabilityRoute)[] {
  return [route, ...chain.filter((c) => !(c.provider === route.provider && c.model === route.model))];
}

export const CAPABILITY_LABEL: Record<Capability, string> = { vision: "vision", code: "code", longContext: "long contexte" };
