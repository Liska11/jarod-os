/**
 * V-02 — timeline auditée : les lignes du journal d'audit d'UNE conversation (chaque appel passé par la porte unique, lecture comprise), pour la
 * vue placée sous chaque tour du chat. Lecture seule ; le renderer ne désigne qu'un identifiant de conversation. Les arguments et la cible sont
 * déjà masqués à l'écriture (`auditArgs`, `redactCommandText`).
 */
import type { AuditEntry } from "@jarod/plugin-agent";
import type { HandlerContext } from "./context.js";

const SESSION_ID = /^[\w.:-]{1,128}$/;
const MAX = 500;

export function createAuditHandlers(ctx: HandlerContext) {
  return {
    "audit-session": (sessionId: unknown, limit?: unknown): (AuditEntry & { at: number })[] => {
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("identifiant de conversation invalide");
      const n = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX) : MAX;
      return ctx.kernel().agent.auditOf(sessionId, n);
    },
  };
}
