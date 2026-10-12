/**
 * @jarod/plugin-mcp — `ctx.mcp` : serveurs MCP (stdio et HTTP) dont les outils rejoignent le registre.
 * Câblage `core.ts:367,682,1786`.
 */
import type {} from "@jarod/plugin-storage";
import type {} from "@jarod/plugin-tools";
import type { Context } from "cordis";
import { McpManager } from "./mcp.js";

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
  const mcp = new McpManager(ctx.tools.registry);
  ctx.provide("mcp", mcp);
  // MCP servers can be slow to boot: don't block startup on them. (core.ts:681-682)
  if (config?.autoSync !== false) void mcp.sync(ctx.storage.settings.get("mcpServers"));
  ctx.effect(() => () => mcp.stopAll(), "mcp:servers");
}
