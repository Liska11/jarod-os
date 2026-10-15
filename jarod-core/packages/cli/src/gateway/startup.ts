// Un échec de démarrage de la passerelle doit se lire en une ligne : la fenêtre n'affiche que ces messages, et
// une pile Node brute ne dit à l'utilisateur ni ce qui s'est passé ni quoi faire. Le cas vu en vrai : le profil
// est déjà servi par une autre instance (`RuntimeLockError`), ou le port fixe est pris (`EADDRINUSE`).
import { redactText } from "@jarod/kernel/redact";
import { RuntimeLockError } from "@jarod/plugin-agent";

export interface StartupFailure {
  /** Code de sortie : 2 = arguments (`JAROD_HOME`, `--workspace`), 3 = démarrage refusé. */
  code: number;
  message: string;
}

/** La fenêtre n'affiche qu'une ligne : au-delà, ce n'est plus un message mais une pile déguisée. */
export const MAX_STARTUP_MESSAGE = 300;

/**
 * Un message de démarrage traverse le masque unique du noyau avant d'atteindre la fenêtre ou un journal : une
 * erreur inattendue peut citer une URL, une clé ou un en-tête recrachés par un provider, et un démarrage n'est
 * pas un endroit où un secret peut apparaître (règle R3.4). Borné aussi en longueur.
 */
export function boundedMessage(text: string): string {
  return redactText(text).slice(0, MAX_STARTUP_MESSAGE);
}

/** Traduit un échec d'ouverture (verrou de profil) ou d'écoute (port) en message d'une ligne. Ne jette jamais. */
export function startupFailure(e: unknown): StartupFailure {
  if (e instanceof RuntimeLockError) {
    // Ce message dit déjà quoi faire : qui tient le profil, et comment l'arrêter.
    return { code: 3, message: boundedMessage(e.message) };
  }

  const err = e as NodeJS.ErrnoException | null;
  if (err?.code === "EADDRINUSE") {
    const port = (e as { port?: unknown }).port;
    return {
      code: 3,
      message: `Le port${typeof port === "number" ? ` ${port}` : ""} est déjà utilisé par un autre programme : fermez-le, ou laissez le shell en choisir un (JAROD_GATEWAY_PORT).`,
    };
  }

  return { code: 3, message: boundedMessage(`Démarrage impossible : ${e instanceof Error ? e.message : String(e)}`) };
}
