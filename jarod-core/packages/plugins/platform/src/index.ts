/**
 * @jarod/plugin-platform — plateforme de plugins : manifeste signé, graphe de dépendances, quotas et budgets,
 * contrôles de santé, cycle de vie (installer, activer, désactiver, mettre à jour, retirer), quarantaine et
 * retour arrière. Voir `platform.ts` pour les règles tenues.
 *
 * Le gestionnaire ne charge rien lui-même : il demande à un `PluginHost`. Aucune capacité nouvelle n'entre dans
 * le processus sans être déclarée, signée, approuvée et bornée ici.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "cordis";
import { type PlatformDeps, PluginPlatform } from "./platform.js";

export * from "./graph.js";
export * from "./manifest.js";
export * from "./platform.js";

declare module "cordis" {
  interface Context {
    plugins: PluginPlatform;
  }
}

export const name = "platform";

/** Sans hôte ni clé de confiance fournis, rien ne s'installe : le service existe mais refuse tout. */
export function apply(ctx: Context, config: Partial<PlatformDeps> = {}): void {
  const host = config.host ?? {
    activate: async () => {
      throw new Error("aucun hôte de plugins branché");
    },
    deactivate: async () => undefined,
    health: async () => false,
  };
  ctx.provide("plugins", new PluginPlatform({ stateFile: join(tmpdir(), "jarod-plugins", "state.json"), trusted: {}, ...config, host }));
}
