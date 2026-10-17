/**
 * @jarod/plugin-mcp — `ctx.mcp` : serveurs MCP (stdio et HTTP) dont les outils rejoignent le registre.
 * Câblage `core.ts:367,682,1786`.
 */
import type {} from "@jarod/plugin-storage";
import type {} from "@jarod/plugin-tools";
import type { Context } from "cordis";
import { McpManager, SqlPinStore } from "./mcp.js";

export * from "./mcp.js";

declare module "cordis" {
  interface Context {
    mcp: McpManager;
  }
}

export const name = "mcp";
export const inject = ["storage", "tools"];

export interface McpPluginConfig {
  /**
   * Démarrer les serveurs déclarés dans les réglages (défaut : oui, comme `init()`). Le CLI `ask`,
   * qui n'appelait pas `init()`, passe `false` : aucun processus MCP lancé pour une question.
   */
  autoSync?: boolean;
}

export function apply(ctx: Context, config: McpPluginConfig = {}): void {
  const mcp = new McpManager(ctx.tools.registry, {
    pins: new SqlPinStore(ctx.storage.db),
    // Journal d'audit existant, lisible par la vue d'audit : une divergence y figure comme un refus.
    audit: (e) => {
      const tool = `mcp:${e.server}${e.tool ? `/${e.tool}` : ""}`;
      const args = e.kind === "pinned" ? `${e.count} outil(s) épinglé(s)` : `sha256 ${e.pinned?.slice(0, 12) ?? "-"} -> ${e.current?.slice(0, 12) ?? "-"}`;
      const decision = e.kind === "pinned" ? "automatique" : e.kind === "approved" ? "accordé" : "refusé";
      ctx.storage.events.append("audit", "mcp-pin", { sessionId: "mcp", tool, args, decision, ...(e.kind === "approved" ? { ok: true } : {}) });
    },
  });
  ctx.provide("mcp", mcp);
  // MCP servers can be slow to boot: don't block startup on them. (core.ts:681-682)
  if (config?.autoSync !== false) void mcp.sync(ctx.storage.settings.get("mcpServers"));
  ctx.effect(() => () => mcp.stopAll(), "mcp:servers");
}
