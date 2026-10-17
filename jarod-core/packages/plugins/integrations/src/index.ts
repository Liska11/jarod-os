/**
 * @jarod/plugin-integrations — registre des intégrations externes (adaptateurs versionnés, licences vérifiées,
 * politique appliquée par les tests), observateur d'injections en mode observation, épurateur d'attributs de
 * trace. Aucun de ces éléments n'exécute quoi que ce soit : ils ne créent aucun canal à côté de
 * `executeGuardedTool`.
 */
import type { Context } from "cordis";
import { assertAdapters, REGISTRY } from "./adapters.js";

export * from "./adapters.js";
export * from "./observer.js";
export * from "./recipes/index.js";
export * from "./telemetry.js";

declare module "cordis" {
  interface Context {
    integrations: { registry: typeof REGISTRY };
  }
}

export const name = "integrations";

export function apply(ctx: Context): void {
  // Un registre qui viole la politique empêche le démarrage de ce plugin : mieux vaut s'arrêter que mentir.
  assertAdapters(REGISTRY);
  ctx.provide("integrations", { registry: REGISTRY });
}
