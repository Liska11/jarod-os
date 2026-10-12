/**
 * Secrets illisibles (AV2-009). Le chiffreur de l'application REFUSE toute valeur qui n'est pas passée par le trousseau de l'OS
 * (`ss:`), sans migration automatique (décision du 2026-10-05) : le refus ne doit jamais être silencieux. Ce canal rend les NOMS
 * des clés concernées — jamais une valeur — pour que l'écran les liste et propose de les ressaisir.
 */
import type { HandlerContext } from "./context.js";

export function createSecretsHandlers(ctx: HandlerContext) {
  return {
    "secrets-unreadable": (): { keys: string[] } => ({ keys: ctx.kernel().agent.settings.unreadableSecrets() }),
  };
}
