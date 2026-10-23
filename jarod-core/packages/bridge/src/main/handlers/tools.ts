/**
 * Écran « Capabilities » (Outils) : outils de l'agent et serveurs MCP.
 * Sources des formes : SANK-UI `src/main/tools.ts:8-13` (`ToolsetInfo`), `:213-242` (`getToolsets`,
 * `setToolsetEnabled` : booléen, false si la clé est invalide), `src/main/mcp-servers.ts:3-17`
 * (`McpServerInfo`), `:667-681` (`listMcpServers`), `ipc/register.ts:2502-2518,3190-3192` ; usage
 * `renderer/src/screens/Tools/Tools.tsx:362-401` (rév. 3aaadb0, MIT © github.com/fathah).
 *
 * Écarts assumés (DECISIONS D1(b)) :
 * - « toolsets » Hermes (familles fixes : web, browser, terminal…) → les OUTILS du registre Jarod, un par
 *   ligne (`ToolRegistry.info`) : clé = nom de l'outil, activé = absent du réglage `disabledTools` (celui que
 *   l'agent applique déjà à chaque tour) — aucune famille inventée ;
 * - serveurs MCP = réglage `mcpServers` ; les VALEURS des variables d'environnement ne sortent pas du main
 *   (masquées) et les en-têtes HTTP (jetons) ne sont pas exposés : un renderer compromis ne lit aucun secret.
 */
import type { McpServerConfig } from "@jarod/contracts";
import { assertProfile, type HandlerContext } from "./context.js";

/** Valeur affichée à la place d'un secret (variable d'environnement d'un serveur MCP). */
export const SECRET_MASK = "••••••••";

type McpTransport = "http" | "stdio" | "unknown";

/** `McpServerInfo` (mcp-servers.ts:5-17). */
export interface McpServerInfo {
  name: string;
  type: McpTransport;
  transport: McpTransport;
  enabled: boolean;
  detail: string;
  url?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  auth?: string;
  tools?: unknown;
  /** V-14 : liste blanche des outils (noms du serveur) ; absente = tous. Des noms, jamais un secret. */
  allowedTools?: string[];
}

export function toMcpServerInfo(c: McpServerConfig): McpServerInfo {
  const transport: McpTransport = c.url ? "http" : c.command ? "stdio" : "unknown";
  return {
    name: c.name,
    type: transport,
    transport,
    enabled: c.enabled,
    detail: c.url || c.command || "",
    ...(c.url ? { url: c.url } : c.command ? { command: c.command } : {}),
    args: c.url ? [] : [...(c.args ?? [])],
    env: Object.fromEntries(Object.keys(c.env ?? {}).map((k) => [k, SECRET_MASK])),
    ...(c.allowedTools ? { allowedTools: [...c.allowedTools] } : {}),
  };
}

export function createToolsHandlers(ctx: HandlerContext) {
  const agent = () => ctx.kernel().agent;
  const settings = () => agent().settings;

  return {
    "get-toolsets": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return agent()
        .tools.info(settings().get("disabledTools"))
        .map((t) => ({ key: t.name, label: t.name, description: t.description, enabled: t.enabled }));
    },
    /** Outil inconnu du registre → false (forme SANK-UI d'une clé invalide), rien d'écrit. */
    "set-toolset-enabled": (key: unknown, enabled: unknown, profile?: unknown): boolean => {
      assertProfile(ctx, profile);
      if (typeof key !== "string" || typeof enabled !== "boolean" || !agent().tools.get(key)) return false;
      const off = new Set(settings().get("disabledTools"));
      if (enabled) off.delete(key);
      else off.add(key);
      settings().set("disabledTools", [...off].sort());
      return true;
    },
    "list-mcp-servers": (profile?: unknown): McpServerInfo[] => {
      assertProfile(ctx, profile);
      return settings().get("mcpServers").map(toMcpServerInfo);
    },
  };
}
