/**
 * M1/M2 (audit v4) — la garde UNIQUE que reçoit tout handler du main.
 *
 * Avant, `createHandlers` recevait `kernel: () => kernel!` : pendant la fermeture de l'application et pendant
 * une bascule de profil, cet accesseur rendait un kernel FERMÉ (base close) ou `null`. Une garde posée dans
 * un seul handler (`profiles.ts`, commit `1b5d4612`) protégeait cet écran-là ; les ~270 autres partaient sur
 * une base fermée, ou sur `null` avec une erreur d'accès à une propriété.
 *
 * Deux états distincts, parce qu'ils demandent deux messages distincts :
 *  - « il n'y a pas de kernel » (`null`) : au démarrage, ou après un double échec d'ouverture ;
 *  - « le kernel n'est pas servable » : la raison est écrite (`profil en cours de bascule`,
 *    `application en cours de fermeture`) — et c'est le cas le plus vicieux, parce que le kernel RETENU
 *    existe encore : c'est celui qu'on vient de fermer.
 */
export interface KernelAccessState<T> {
  /** Le kernel retenu, ou null s'il n'y en a aucun. */
  kernel: () => T | null;
  /** La raison pour laquelle il n'est pas servable, ou null s'il l'est. */
  unavailable: () => string | null;
}

/** L'accesseur à donner aux handlers : il refuse avec une raison écrite, jamais par un `null` implicite. */
export function kernelAccessor<T>(state: KernelAccessState<T>): () => T {
  return () => {
    const why = state.unavailable();
    if (why) throw new Error(`[oneai] ${why}`);
    const k = state.kernel();
    if (!k) throw new Error("[oneai] kernel non disponible");
    return k;
  };
}