/**
 * D1(b) — comptes : connexion OAuth aux fournisseurs, compte Hermes One (connexion par code d'appareil, clé
 * d'inférence, crédits) et synchronisation des agents avec le cloud. Sources : SANK-UI `src/main/ipc/register.ts:
 * 840-968`, `hermes-auth.ts:169-173`, `hermes-account.ts:278-282`, `hermesone-provision.ts:125-128`,
 * `shared/account.ts:17-27`, `shared/agent-sync.ts:25-32` — rév. 3aaadb0, MIT © github.com/fathah.
 *
 * Jarod-One n'a ni OAuth de fournisseur (une clé API par fournisseur, coffre du profil), ni compte Hermes One
 * (`hermes-account-get` = null, `agent-sync-status` déconnecté). Réponses = celles de SANK-UI DÉCONNECTÉ :
 * annuler sans connexion en cours → false ; crédits → `{ balance: null, error: "signed-out" }` ; clé Hermes One
 * → `signed-out` ; synchronisation → `signed-out` sans résultat ; se déconnecter → succès (l'état voulu est
 * atteint). Se CONNECTER échoue avec la raison (`success: false`, forme SANK-UI d'un échec de connexion).
 */
import type { AgentSyncResult } from "../../sank/src/shared/agent-sync.js";
import type { EnsureHermesOneKeyResult, HermesOneCreditsResult } from "../../sank/src/shared/account.js";
import { assertProfile, type HandlerContext } from "./context.js";

const NO_OAUTH = "Jarod-One ne se connecte pas aux fournisseurs par OAuth : enregistre une clé API dans Fournisseurs.";
const NO_ACCOUNT = "Jarod-One n'a pas de compte Hermes One.";

export function createAccountHandlers(ctx: HandlerContext) {
  return {
    "oauth-login": (_provider: unknown, profile?: unknown) => {
      assertProfile(ctx, profile);
      return { success: false, error: NO_OAUTH };
    },
    "oauth-login-cancel": () => false,
    // Aucun fournisseur OAuth : aucun statut (l'écran n'affiche que les fournisseurs listés).
    "get-oauth-provider-statuses": (profile?: unknown): Record<string, boolean> => {
      assertProfile(ctx, profile);
      return {};
    },
    "hermes-account-login": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return { success: false, error: NO_ACCOUNT };
    },
    "hermes-account-login-cancel": () => false,
    "hermes-account-logout": () => ({ success: true }),
    "hermesone-ensure-key": (profile?: unknown): EnsureHermesOneKeyResult => {
      assertProfile(ctx, profile);
      return { status: "signed-out" };
    },
    "hermesone-credits": (): HermesOneCreditsResult => ({ balance: null, error: "signed-out" }),
    "agent-sync-run": (): AgentSyncResult => ({ status: "signed-out", outcomes: [], finishedAt: Date.now() }),
    "agent-sync-linked-id": (): null => null,
  };
}
