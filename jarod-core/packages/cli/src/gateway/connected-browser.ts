// E2 (navigateur connecté) dans la passerelle : le branchement au cycle de vie, ÉTEINT par défaut.
//
// Rien n'est ajouté aux outils et aucun navigateur ne démarre tant que l'utilisateur n'a pas activé le réglage « Navigateur connecté » avec au moins un domaine
// ET que le moteur n'est pas trouvé sous JAROD_E2_ENGINE_ROOT (absente : « moteur absent »). Le navigateur est TOUJOURS un Chrome jetable à profil neuf, lancé par
// Jarod : la passerelle ne reçoit et ne lit jamais le profil de l'utilisateur, et aucune variable d'environnement ne peut en désigner un.
import type { CliCore } from "../context.js";

export interface ConnectedBrowserHandle {
  stop(): Promise<void>;
  status(): { state: string; reason: string; blocked: number };
  sync(): Promise<void>;
}

type Starter = (o: { settings: unknown; engineRoot?: string; log?: (line: string) => void }) => ConnectedBrowserHandle;

export function startConnectedBrowser(core: Pick<CliCore, "app" | "settings">, env: NodeJS.ProcessEnv, log: (line: string) => void): ConnectedBrowserHandle | undefined {
  const integrations = (core.app as unknown as { integrations?: { startConnectedBrowserLifecycle?: Starter } }).integrations;
  const root = env.JAROD_E2_ENGINE_ROOT?.trim();
  return integrations?.startConnectedBrowserLifecycle?.({ settings: core.settings, ...(root ? { engineRoot: root } : {}), log });
}
