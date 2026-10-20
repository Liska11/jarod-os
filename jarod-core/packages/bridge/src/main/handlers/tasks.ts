/**
 * Écran « Tâches » (cockpit, lot 2) : les actions passées par la porte unique de l'agent — cible, action résolue, étapes, statut, preuve —
 * et l'annulation d'une tâche vivante. Le renderer ne désigne qu'un identifiant de tâche ; il ne lance rien.
 */
import type { TaskRecord } from "@jarod/plugin-agent";
import type { HandlerContext } from "./context.js";

const ID = /^[0-9a-f-]{36}$/i;
const MAX = 200;

export function createTaskHandlers(ctx: HandlerContext) {
  const ledger = () => ctx.kernel().agent.tasks;
  return {
    "tasks-list": (limit?: unknown): TaskRecord[] => {
      const n = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX) : MAX;
      return ledger().list(n);
    },
    "task-cancel": (id: unknown): { success: boolean; error?: string } => {
      if (typeof id !== "string" || !ID.test(id)) return { success: false, error: "identifiant invalide" };
      return ledger().cancel(id) ? { success: true } : { success: false, error: "tâche finie ou inconnue" };
    },
  };
}
