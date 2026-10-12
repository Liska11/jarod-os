/**
 * @jarod/plugin-kanban — `ctx.kanban` : tableaux et tâches (Q17, BESOINS ; PLAN §2 « plugin-kanban », P4),
 * rangés dans `jarod.db` (migration v17 de plugin-storage : chiffrés, emportés par la sauvegarde complète du
 * profil et restaurés avec lui). L'exécution d'une tâche est un tour d'agent déclenché à la main par le desktop
 * (`kanban-dispatch-once`) : ce plugin n'a pas de minuteur de répartition.
 */
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { KanbanService } from "./kanban.js";

export * from "./kanban.js";
export * from "./specify.js";

declare module "cordis" {
  interface Context {
    kanban: KanbanService;
  }
}

export const name = "kanban";
export const inject = ["storage"];

export function apply(ctx: Context): void {
  const kanban = new KanbanService(ctx.storage.db);
  // Un tour perdu par un arrêt pendant l'exécution : la tâche redevient prête (rien ne la relance).
  kanban.recoverInterrupted();
  ctx.provide("kanban", kanban);
}
