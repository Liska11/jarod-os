/**
 * Chemin de démarrage des écrans SANK-UI (D1) : `App.tsx:44-100` (rév. 3aaadb0) lit `get-connection-config`
 * puis `check-install` pour choisir Accueil (installer Hermes) / Configuration (clé) / écran principal, et
 * `verify-install` en tâche de fond. Formes : SANK-UI `src/main/config.ts:129-141` (`PublicConnectionConfig`)
 * (valeurs par défaut de `getConnectionConfig`, :107-128) et `src/main/installer.ts:469-527` (`InstallStatus`),
 * MIT © github.com/fathah.
 *
 * Écarts assumés (consignés DECISIONS) — Jarod n'a pas de backend Python Hermes à installer :
 * - `installed` / `verified` = le kernel a démarré (les handlers ne sont servis qu'après lui) ;
 * - `hasApiKey` = le fournisseur actif est utilisable : clé enregistrée OU fournisseur local, même règle que
 *   `ProviderRouter.list()` (`configured`) — sinon SANK-UI ouvre son écran de configuration ;
 * - connexion : toujours `local` (accès distant/SSH non portés) ; `set-connection-config`, tunnels SSH et
 *   test distant restent « non portés ».
 * - Réglages (D1(b), `useSettingsData.ts:150-253`) : `get-hermes-home` = dossier du profil SERVI (`config.ts:1118`
 *   = dossier du profil Hermes) ; `get-hermes-version` = null (réponse SANK-UI sans CLI Hermes,
 *   `installer.ts:564-566`) ; `check-openclaw` = non trouvé (Jarod n'a pas la migration OpenClaw → Hermes, pas
 *   d'offre à afficher).
 * - Moteur Hermes (D1(b), `register.ts:700-760,1170-1190`, `installer.ts`) : `start-install` / `run-hermes-update` /
 *   `run-claw-migrate` échouent avec la raison (forme SANK-UI d'un échec : `{ success: false, error }`) — le kernel
 *   est intégré à l'application, ses mises à jour passent par l'écran Mises à jour (plugin-updates) ;
 *   `inspect-install-target` et `validate-/adopt-hermes-home` LÈVENT (Jarod n'adopte pas un HERMES_HOME externe :
 *   `false` ferait croire à un dossier invalide) ; `refresh-hermes-version` = null, comme `get-hermes-version`.
 */
import { ProfileManager } from "@jarod/plugin-persona";
import { assertProfile, type HandlerContext } from "./context.js";

const ENGINE_BUILT_IN = "Jarod-One n'installe pas le moteur Hermes (Python) : son kernel est intégré à l'application.";

const notApplicable = (): never => {
  throw new Error(`[oneai] ${ENGINE_BUILT_IN}`);
};

export function createInstallHandlers(ctx: HandlerContext) {
  return {
    // Le `desktop.json` vide de SANK-UI : mode local, réglages distants/SSH à leurs valeurs par défaut.
    "get-connection-config": () => ({
      mode: "local" as const,
      remoteUrl: "",
      remoteAuthMode: "auto" as const,
      remoteChatTransport: "auto" as const,
      sshChatTransport: "auto" as const,
      hasApiKey: false,
      apiKeyLength: 0,
      ssh: { host: "", port: 22, username: "", keyPath: "", remotePort: 8642, localPort: 18642, dockerContainerName: "" },
    }),
    "check-install": () => {
      const k = ctx.kernel();
      const active = k.agent.settings.get("activeProvider");
      const hasApiKey = k.agent.providers.list().some((p) => p.id === active && p.configured);
      return { installed: true, configured: true, hasApiKey, verified: true, activeProfile: k.profile };
    },
    "verify-install": () => true,
    "get-hermes-home": (profile?: unknown): string => {
      assertProfile(ctx, profile);
      const k = ctx.kernel();
      return new ProfileManager(k.dataRoot).dirFor(k.profile);
    },
    "get-hermes-version": (): null => null,
    "refresh-hermes-version": (): null => null,
    "check-openclaw": () => ({ found: false, path: null }),
    "start-install": () => ({ success: false, error: ENGINE_BUILT_IN }),
    "run-hermes-update": () => ({
      success: false,
      error: "Le moteur de Jarod-One se met à jour avec l'application : écran Mises à jour.",
    }),
    "run-claw-migrate": () => ({ success: false, error: "Jarod-One n'a pas de migration OpenClaw → Hermes." }),
    "inspect-install-target": notApplicable,
    "validate-hermes-home": notApplicable,
    "adopt-hermes-home": notApplicable,
  };
}
