/**
 * V-02 — timeline auditée : les lignes du journal d'audit d'UNE conversation (chaque appel passé par la porte unique, lecture comprise), pour la
 * vue placée sous chaque tour du chat. Lecture seule ; le renderer ne désigne qu'un identifiant de conversation. Les arguments et la cible sont
 * déjà masqués à l'écriture (`auditArgs`, `redactCommandText`).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry } from "@jarod/plugin-agent";
import type { HandlerContext } from "./context.js";

const SESSION_ID = /^[\w.:-]{1,128}$/;
const MAX = 500;
/** Ce qu'on lit au plus à la fin d'un journal texte : assez pour `MAX` lignes de `mcp-server.log` (~80 octets chacune). */
const TAIL_BYTES = 256 * 1024;

/**
 * Les `n` dernières lignes COMPLÈTES d'un fichier (la génération tournée `<nom>.1` d'abord si la courante n'en a pas assez), sans le lire en
 * entier. Absent ou illisible : aucune ligne. Une première ligne coupée par la lecture partielle est écartée.
 */
export function tailLines(file: string, n: number): string[] {
  const read = (path: string): string[] => {
    let fd: number | null = null;
    try {
      const size = statSync(path).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fd = openSync(path, "r");
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf8").split(/\r?\n/);
      if (start > 0) lines.shift();
      return lines.filter((l) => l.trim());
    } catch {
      return [];
    } finally {
      if (fd !== null) closeSync(fd);
    }
  };
  const current = read(file);
  const lines = current.length >= n ? current : [...read(`${file}.1`), ...current];
  return lines.slice(-n);
}

export function createAuditHandlers(ctx: HandlerContext) {
  return {
    "audit-session": (sessionId: unknown, limit?: unknown): (AuditEntry & { at: number })[] => {
      if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("identifiant de conversation invalide");
      const n = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX) : MAX;
      return ctx.kernel().agent.auditOf(sessionId, n);
    },
    /**
     * V-03 — la part du noyau dans la vue unique des journaux : les dernières lignes de l'agent (toutes conversations) et celles de
     * `mcp-server.log` (`jarod mcp`, même racine de données), brutes. Le shell y ajoute les siennes et les ramène à une forme commune.
     */
    "audit-recent": (limit?: unknown): { agent: (AuditEntry & { at: number })[]; mcpServer: string[] } => {
      const n = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX) : MAX;
      const k = ctx.kernel();
      return { agent: k.agent.auditLog(n), mcpServer: tailLines(join(k.dataRoot, "mcp-server.log"), n) };
    },
  };
}
