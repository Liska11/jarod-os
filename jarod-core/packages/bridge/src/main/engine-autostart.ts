/**
 * Démarrage automatique du moteur local à l'ouverture du kernel du bureau : les MÊMES trois gardes que `jarod serve` (`@jarod/plugin-llm`,
 * `engine-autostart.ts`) — échec non fatal et journalisé, jamais en mode test ni sur un profil temporaire, annonce de l'état réel et non du réglage.
 * Séparé de `index.ts` (qui importe electron) pour être testé sans lui.
 */
import { type AutoStartEngine, engineAutoStartBlock, startLocalEngine } from "@jarod/plugin-llm";

export interface AutoStartKernel {
  dataRoot: string;
  localEngine?: { engine: AutoStartEngine };
}

/** Lance (ou refuse de lancer) le moteur local, journalise l'état réel ; ne rejette JAMAIS. */
export async function autoStartLocalEngine(
  kernel: AutoStartKernel,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  tmpRoot?: string,
): Promise<void> {
  try {
    log(await startLocalEngine(kernel.localEngine?.engine, engineAutoStartBlock(kernel.dataRoot, env, tmpRoot), log));
  } catch (e) {
    log(`Moteur local : démarrage automatique abandonné — ${(e as Error).message.slice(0, 300)}`);
  }
}
