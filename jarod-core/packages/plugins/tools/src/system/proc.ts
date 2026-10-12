// Outils système (phases 2 et 3) : ce que `system_quit_app` et `system_kill_process` partagent — les processus qu'on ne touche jamais, et la lecture
// des erreurs de CLOSE_WINDOW / FORCE_KILL (le premier mot de l'erreur dit ce qui s'est passé).
import { win32 } from "node:path";

/** Les programmes dont l'arrêt termine la session ou la machine, plus l'Explorateur (bureau et barre des tâches). Comparés sans casse ni « .exe ». */
export const CRITICAL_PROCESS_NAMES: ReadonlySet<string> = new Set([
  "system", "system idle process", "registry", "secure system", "memory compression", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "dwm",
  "svchost", "fontdrvhost", "explorer",
]);

/** Les pid qui ne sont à personne : 0 (inactivité) et 4 (système). */
export const CRITICAL_PIDS: ReadonlySet<number> = new Set([0, 4]);

/** Le nom d'un programme sans dossier ni `.exe`, en minuscules. */
export const stem = (nameOrPath: string): string => win32.basename(nameOrPath).toLowerCase().replace(/\.exe$/, "");

export interface ProcessRef {
  pid: number | null;
  name: string;
  path?: string;
}

/**
 * Le motif pour lequel un processus ne doit pas être arrêté, ou `null`. Jarod lui-même (son pid et celui de son parent) en fait partie : s'arrêter
 * en plein tour casserait la conversation qui le demande.
 */
export function protectedReason(p: ProcessRef, ownPids: Iterable<number>): string | null {
  const own = new Set(ownPids);
  if (p.pid !== null && own.has(p.pid)) return "c'est Jarod lui-même ou le programme qui le lance";
  if (p.pid !== null && CRITICAL_PIDS.has(p.pid)) return "c'est un processus du système";
  if (CRITICAL_PROCESS_NAMES.has(stem(p.name)) || (p.path && CRITICAL_PROCESS_NAMES.has(stem(p.path)))) return "c'est un processus du système ou l'Explorateur";
  return null;
}

/** Les erreurs des scripts d'arrêt, en phrases. */
export function stopErrorMessage(raw: string): string {
  if (/NOTFOUND/.test(raw)) return "le processus n'existe plus";
  if (/CHANGED/.test(raw)) return "le numéro de processus a été réattribué à un autre programme entre-temps (rien n'a été fermé)";
  if (/DENIED/.test(raw)) return "accès refusé (processus d'un autre compte ou protégé)";
  if (/NOWINDOW/.test(raw)) return "pas de fenêtre à fermer poliment (la fermeture de force existe : force=true, le travail non enregistré est perdu)";
  return raw;
}
