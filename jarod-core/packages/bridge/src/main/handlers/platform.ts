/**
 * Écran « Plateforme » : plugins de la plateforme (phase 4), quarantaine, bacs à sable, Hyper-V (phase 3.3), et l'approbation des
 * outils MCP dont la description a changé (épinglage SHA-256). Lecture seule, sauf `mcp-approve-tool`, qui n'accepte que deux
 * identifiants (serveur, outil) : le renderer ne désigne jamais un chemin, un contenu ni une empreinte.
 */
import type { HandlerContext, McpServerView, PlatformSnapshot } from "./context.js";

export interface PlatformStatus extends PlatformSnapshot {
  mcp: McpServerView[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;

export function createPlatformHandlers(ctx: HandlerContext) {
  return {
    "platform-status": async (): Promise<PlatformStatus> => {
      const k = ctx.kernel();
      const snap: PlatformSnapshot = k.platform ? await k.platform.snapshot() : { plugins: [], sandboxes: [], quarantine: [], hyperv: null };
      return { ...snap, mcp: k.mcp?.list?.() ?? [] };
    },
    "mcp-approve-tool": (serverId: unknown, tool: unknown): { success: boolean; error?: string } => {
      if (typeof serverId !== "string" || typeof tool !== "string" || !ID.test(serverId) || !ID.test(tool)) return { success: false, error: "identifiants invalides" };
      const mcp = ctx.kernel().mcp;
      if (!mcp?.approve) return { success: false, error: "MCP indisponible : plugin-mcp est désactivé" };
      try {
        mcp.approve(serverId, tool);
        return { success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message.slice(0, 200) };
      }
    },
  };
}
