/**
 * @jarod/plugin-platform — plateforme de plugins : manifeste signé, graphe de dépendances, quotas et budgets,
 * contrôles de santé, cycle de vie (installer, activer, désactiver, mettre à jour, retirer), quarantaine et
 * retour arrière. Voir `platform.ts` pour les règles tenues.
 *
 * Le gestionnaire ne charge rien lui-même : il demande à un `PluginHost`. Aucune capacité nouvelle n'entre dans
 * le processus sans être déclarée, signée, approuvée et bornée ici.
 *
 * V-06 : chargé AVANT plugin-workflows (ordre 88 < 90), qui lui attache l'hôte réel (`attachHost`) et ne lance plus
 * un plugin que la plateforme n'a pas installé. Avec plugin-storage : état sous les données du profil, et une clé
 * LOCALE (local-key.ts) pour les plugins que la personne approuve elle-même.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "cordis";
import { type KeyDb, type LocalKeys, localKeys } from "./local-key.js";
import type { PluginManifest } from "./manifest.js";
import { type PlatformDeps, PluginPlatform } from "./platform.js";

export * from "./graph.js";
export * from "./local-key.js";
export * from "./manifest.js";
export * from "./platform.js";

/** La plateforme, et la signature locale quand le profil a une base (sinon : seuls les éditeurs de confiance). */
export class PlatformService extends PluginPlatform {
  constructor(
    deps: PlatformDeps,
    private readonly local: LocalKeys | null,
  ) {
    super(deps);
  }

  /** Signe un manifeste avec la clé locale du profil. N'est appelé qu'après l'accord natif de la personne (bridge, CLI). */
  signLocal(manifest: PluginManifest): PluginManifest {
    if (!this.local) throw new Error("aucune clé locale : la plateforme n'a pas de base de profil");
    return this.local.sign(manifest);
  }
}

declare module "cordis" {
  interface Context {
    plugins: PlatformService;
  }
}

export const name = "platform";
export const inject = { storage: { required: false } };

/** Sans hôte attaché ni clé de confiance, rien ne s'installe : le service existe mais refuse tout. */
export function apply(ctx: Context, config: Partial<PlatformDeps> = {}): void {
  const host = config.host ?? {
    activate: async () => {
      throw new Error("aucun hôte de plugins branché");
    },
    deactivate: async () => undefined,
    health: async () => false,
  };
  const storage = ctx.get("storage") as unknown as { dataDir?: string; db?: KeyDb } | undefined;
  const local = storage?.db ? localKeys(storage.db) : null;
  const stateFile = storage?.dataDir ? join(storage.dataDir, "plugin-platform.json") : join(tmpdir(), "jarod-plugins", "state.json");
  ctx.provide("plugins", new PlatformService({ stateFile, ...config, trusted: { ...(config.trusted ?? {}), ...(local?.publicKeys ?? {}) }, host }, local));
}
