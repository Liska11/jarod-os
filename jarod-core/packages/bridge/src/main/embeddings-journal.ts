/**
 * Journal des sorties du worker d'embeddings isolé (SPECS-P5-EMBEDDINGS.md §3.3) : une ligne JSON par arrêt non demandé —
 * horodatage, pid, code de sortie, motif, issue (relancé ou abandonné), relances dans la fenêtre. JAMAIS de texte de document ni de
 * requête (l'événement n'en porte pas). Une écriture qui échoue ne casse jamais la relance du worker.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface EmbeddingsExitEvent {
  pid: number | null;
  code: number | null;
  reason: "exit" | "timeout" | "port-busy";
  outcome: "restarted" | "gave-up";
  restartsInWindow: number;
}

export function embeddingsExitJournal(file: string, now: () => number = Date.now): (event: EmbeddingsExitEvent) => void {
  return (event) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const { pid, code, reason, outcome, restartsInWindow } = event;
      appendFileSync(file, `${JSON.stringify({ at: now(), pid, code, reason, outcome, restartsInWindow })}\n`);
    } catch {
      /* le journal est un témoin : jamais un motif d'échec */
    }
  };
}
