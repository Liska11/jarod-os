/**
 * D1(b) — connexion distante / SSH et tableau de bord Hermes. Sources : SANK-UI `src/main/ipc/register.ts:1309-1320`
 * (`is-remote-mode`, `set-connection-config`), `:1322-1560` (SSH, tunnel, passerelle distante, OAuth distant),
 * `:1992-2003` + `dashboard.ts:524-556,707-718` (tableau de bord) — rév. 3aaadb0, MIT © github.com/fathah.
 *
 * Jarod-One se connecte TOUJOURS à son kernel local (`get-connection-config` = `local`, install.ts) : pas de
 * backend Hermes distant, pas de tunnel SSH, pas de tableau de bord Python. Règle des réponses :
 * - un ÉTAT se lit tel qu'il est : pas distant, aucun tunnel, déconnecté de l'OAuth distant ;
 * - un « arrêt » de ce qui ne tourne pas répond `true` (réponse SANK-UI : `stopDashboard` sans tableau géré,
 *   `stop-ssh-tunnel`) — l'état demandé est atteint ;
 * - une ACTION distante (écrire une config distante/SSH, tester, sonder, se connecter, ouvrir un tunnel) LÈVE :
 *   jamais `true` pour une écriture qui n'a pas eu lieu, ni `false` qui ferait croire à un hôte injoignable ;
 * - écrire la config telle qu'elle est déjà (`local`, transports `auto`) est admis (`true`) : c'est l'état servi.
 */
import { assertProfile, type HandlerContext } from "./context.js";

const LOCAL_ONLY = "[oneai] connexion distante non disponible : Jarod-One se connecte toujours à son kernel local";
const NO_DASHBOARD = "Jarod-One n'a pas de tableau de bord Hermes : le chat passe par l'IPC.";

const refuse = (): never => {
  throw new Error(LOCAL_ONLY);
};

export function createRemoteHandlers(ctx: HandlerContext) {
  return {
    "is-remote-mode": () => false,
    // register.ts:1314-1330 : seul le mode déjà servi s'écrit (URL et clé distantes n'ont pas d'usage local).
    "set-connection-config": (mode: unknown, remoteUrl: unknown, apiKey?: unknown): true => {
      const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
      if (mode !== "local" || !empty(remoteUrl) || !empty(apiKey)) refuse();
      return true;
    },
    "set-connection-chat-transports": (remote: unknown, ssh: unknown): true => {
      if (remote !== "auto" || ssh !== "auto") refuse();
      return true;
    },
    "set-ssh-config": refuse,
    "inspect-ssh-hermes-target": refuse,
    "provision-ssh-docker-target": refuse,
    "test-remote-connection": refuse,
    "connect-remote-gateway": refuse,
    "probe-remote-auth-mode": refuse,
    "remote-oauth-login": refuse,
    "remote-oauth-logout": () => ({ signedIn: false as const }),
    "remote-oauth-session-state": () => ({ signedIn: false }),
    "test-ssh-connection": refuse,
    "is-ssh-tunnel-active": () => false,
    "start-ssh-tunnel": refuse,
    "stop-ssh-tunnel": () => true,
    // dashboard.ts:543-546 : la forme SANK-UI d'une plateforme sans tableau de bord (même réponse que `start-dashboard`).
    "dashboard-status": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return { supported: false, running: false, error: NO_DASHBOARD };
    },
    // dashboard.ts:556-590 : sans tableau de bord, SANK-UI lève « Dashboard WebSocket is unavailable ».
    "fresh-dashboard-ws-url": (profile?: unknown): never => {
      assertProfile(ctx, profile);
      throw new Error(`[oneai] ${NO_DASHBOARD}`);
    },
    // dashboard.ts:707-711 : aucun tableau géré → true.
    "stop-dashboard": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return true;
    },
  };
}
