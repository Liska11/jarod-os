/**
 * Écran Capacités › MCP : écritures sur les serveurs MCP (D1(b), suite V1). Sources SANK-UI :
 * `src/main/mcp-servers.ts:66-67` (`SERVER_NAME_RE`, `ENV_NAME_RE`), `:338-400` (`validateServerInput`, repris tel
 * quel), `:681-849` (`addMcpServer`, `updateMcpServer` : renommage refusé si le nom est pris, `removeMcpServer`,
 * `setMcpServerEnabled` ; résultat `{ success, error? }`), `:851-887` (`testMcpServer` : `{ success, tools }`),
 * `:655-665,889-986` (catalogue indisponible : `{ entries: [], diagnostics: [], error }`, installation
 * `{ success: false, error }`) ; `ipc/register.ts` ; usage `renderer/src/screens/Tools/Tools.tsx:465-585`,
 * `Discover.tsx:300` — rév. 3aaadb0, MIT © github.com/fathah. Côté Jarod : `Jarod-one/packages/desktop/src/main/
 * handlers/mcp.ts:13-35` (rév. 2e180305) — réglage `mcpServers` écrit, puis `mcp.sync` (serveurs démarrés/arrêtés).
 *
 * Écarts assumés (DECISIONS D1(b), V1) :
 * - réglage `mcpServers` de Jarod au lieu du bloc `mcp_servers` de `config.yaml` ; un serveur est désigné par son
 *   NOM (forme SANK-UI), l'`id` Jarod est conservé à la modification, créé (UUID) à l'ajout ;
 * - SECRETS : une valeur d'environnement égale au masque (`SECRET_MASK`, ce que `list-mcp-servers` montre) signifie
 *   « inchangée » et reprend la valeur enregistrée — SEULEMENT si la commande est la même ; les en-têtes HTTP
 *   (jetons, jamais exposés) sont gardés SEULEMENT si l'origine de l'URL est la même. Sinon un renderer pourrait
 *   envoyer un secret enregistré à un autre programme ou un autre hôte (même règle que `set-model-config`) : un
 *   masque sans valeur réutilisable est REFUSÉ (jamais le masque écrit comme valeur) ;
 * - `auth: "oauth"` refusé : le client HTTP MCP de Jarod n'a pas d'OAuth (en-têtes statiques seulement) ;
 * - serveur inconnu (retrait, activation) → `{ success: false }` : SANK-UI rend un succès sans rien écrire ;
 * - `test-mcp-server` = connexion temporaire par plugin-mcp (`McpManager.probe`) au lieu de la CLI Hermes ;
 * - catalogue MCP Hermes (`hermes mcp catalog/install`) : Jarod n'en a pas → réponses SANK-UI d'une passerelle
 *   sans catalogue.
 */
import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "@jarod/contracts";
import { assertProfile, type HandlerContext } from "./context.js";
import { SECRET_MASK } from "./tools.js";

/** `McpServerInput` (mcp-servers.ts:24-32). */
export interface McpServerInput {
  name: string;
  type: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  auth?: string;
}

interface McpResult {
  success: boolean;
  error?: string;
  tools?: Array<{ name: string; description: string }>;
}

/** V-14 : ce que voit l'écran de la liste blanche d'un serveur. */
type McpToolsView =
  | { success: true; restricted: boolean; allowed: string[] | null; tools: Array<{ name: string; description: string; allowed: boolean; pinState: string }> }
  | { success: false; error: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: intended, a tool name with a control character is refused
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** V-14 : `null` → tous les outils ; une liste de noms valides → triée, sans doublon ; tout le reste → `undefined` (refus). */
function toolList(tools: unknown): string[] | null | undefined {
  if (tools === null) return null;
  if (!Array.isArray(tools) || tools.length > 500) return undefined;
  if (!tools.every((t) => typeof t === "string" && t.length > 0 && t.length <= 200 && !CONTROL_RE.test(t))) return undefined;
  return [...new Set(tools as string[])].sort();
}

const SERVER_NAME_RE =/^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `validateServerInput` (mcp-servers.ts:338-400), corps verbatim ; entrée non objet refusée en plus. */
function validateServerInput(input: McpServerInput):
  | {
      ok: true;
      value: Required<Pick<McpServerInput, "name" | "type">> & Omit<McpServerInput, "name" | "type">;
    }
  | { ok: false; error: string } {
  const name = (input.name || "").trim();
  if (!SERVER_NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        "Use a server name that starts with a letter or number and contains only letters, numbers, underscores, or hyphens.",
    };
  }

  if (input.type !== "http" && input.type !== "stdio") {
    return { ok: false, error: "Choose HTTP or stdio transport." };
  }

  if (input.type === "http") {
    const url = (input.url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      return {
        ok: false,
        error: "HTTP MCP servers need an http:// or https:// URL.",
      };
    }
    return {
      ok: true,
      value: { ...input, name, type: input.type, url, args: [], env: {} },
    };
  }

  const command = (input.command || "").trim();
  if (!command) return { ok: false, error: "stdio MCP servers need a command." };

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env || {})) {
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    if (!ENV_NAME_RE.test(trimmedKey)) {
      return {
        ok: false,
        error: `Invalid env var name "${trimmedKey}".`,
      };
    }
    env[trimmedKey] = String(value ?? "");
  }

  return {
    ok: true,
    value: {
      ...input,
      name,
      type: input.type,
      command,
      args: (input.args || []).map((arg) => arg.trim()).filter(Boolean),
      env,
    },
  };
}

const originOf = (url: string | undefined): string | null => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

/**
 * Entrée SANK-UI validée → `McpServerConfig` Jarod. `previous` = le serveur modifié : il fournit l'`id`, l'état
 * activé et les secrets réutilisables (voir l'en-tête). Une erreur est rendue au lieu d'un secret déplacé.
 */
function toConfig(input: unknown, previous: McpServerConfig | undefined): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Invalid MCP server input." };
  const v = validateServerInput(input as McpServerInput);
  if (!v.ok) return v;
  const s = v.value;
  if (s.auth) return { ok: false, error: `Jarod-One ne prend pas en charge l'authentification MCP « ${s.auth} » (en-têtes statiques seulement).` };
  // V-14 : la liste blanche suit le serveur modifié — elle ne fait que restreindre, la garder ne déplace aucun droit.
  const base = { id: previous?.id ?? randomUUID(), name: s.name, enabled: previous?.enabled ?? true, ...(previous?.allowedTools ? { allowedTools: [...previous.allowedTools] } : {}) };
  if (s.type === "http") {
    const sameOrigin = previous?.url !== undefined && originOf(previous.url) === originOf(s.url);
    const headers = sameOrigin ? previous?.headers : undefined;
    return { ok: true, config: { ...base, command: "", args: [], env: {}, url: s.url!, ...(headers && Object.keys(headers).length ? { headers: { ...headers } } : {}) } };
  }
  const sameCommand = previous !== undefined && !previous.url && previous.command === s.command;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(s.env ?? {})) {
    if (value !== SECRET_MASK) {
      env[key] = value;
      continue;
    }
    const kept = sameCommand ? previous?.env[key] : undefined;
    if (kept === undefined)
      return { ok: false, error: `Valeur masquée pour « ${key} » : saisissez la valeur (un secret enregistré ne suit pas une autre commande).` };
    env[key] = kept;
  }
  return { ok: true, config: { ...base, command: s.command!, args: s.args ?? [], env } };
}

export function createMcpHandlers(ctx: HandlerContext) {
  const settings = () => ctx.kernel().agent.settings;
  const servers = () => settings().get("mcpServers");
  const find = (name: unknown) => (typeof name === "string" ? servers().find((s) => s.name === name) : undefined);
  /** Écrit le réglage puis aligne les serveurs démarrés (Jarod-one : `settings.set` + `mcp.sync`). */
  const save = async (list: McpServerConfig[], restarted?: McpServerConfig): Promise<McpResult> => {
    settings().set("mcpServers", list);
    const mcp = ctx.kernel().mcp;
    if (mcp) {
      // `sync` ne relance pas un serveur déjà démarré : une configuration modifiée est arrêtée puis reprise.
      if (restarted) await mcp.sync(list.filter((s) => s.id !== restarted.id));
      await mcp.sync(list);
    }
    return { success: true };
  };
  const failure = (err: unknown, fallback: string): McpResult => ({ success: false, error: (err as Error)?.message || fallback });

  return {
    "add-mcp-server": async (input: unknown, profile?: unknown): Promise<McpResult> => {
      assertProfile(ctx, profile);
      const r = toConfig(input, undefined);
      if (!r.ok) return { success: false, error: r.error };
      if (find(r.config.name)) return { success: false, error: `MCP server "${r.config.name}" already exists.` };
      try {
        return await save([...servers(), r.config]);
      } catch (err) {
        return failure(err, "Failed to add MCP server.");
      }
    },
    "update-mcp-server": async (originalName: unknown, input: unknown, profile?: unknown): Promise<McpResult> => {
      assertProfile(ctx, profile);
      const previous = find(originalName);
      if (!previous) return { success: false, error: `MCP server "${String(originalName)}" not found.` };
      const r = toConfig(input, previous);
      if (!r.ok) return { success: false, error: r.error };
      if (r.config.name !== previous.name && find(r.config.name)) return { success: false, error: `MCP server "${r.config.name}" already exists.` };
      try {
        return await save(
          servers().map((s) => (s.id === previous.id ? r.config : s)),
          r.config,
        );
      } catch (err) {
        return failure(err, "Failed to update MCP server.");
      }
    },
    "remove-mcp-server": async (name: unknown, profile?: unknown): Promise<McpResult> => {
      assertProfile(ctx, profile);
      const target = find(name);
      if (!target) return { success: false, error: `MCP server "${String(name)}" not found.` };
      try {
        return await save(servers().filter((s) => s.id !== target.id));
      } catch (err) {
        return failure(err, "Failed to remove MCP server.");
      }
    },
    "set-mcp-server-enabled": async (name: unknown, enabled: unknown, profile?: unknown): Promise<McpResult> => {
      assertProfile(ctx, profile);
      if (typeof enabled !== "boolean") return { success: false, error: "enabled must be a boolean." };
      const target = find(name);
      if (!target) return { success: false, error: `MCP server "${String(name)}" not found.` };
      try {
        return await save(servers().map((s) => (s.id === target.id ? { ...s, enabled } : s)));
      } catch (err) {
        return failure(err, "Failed to update MCP server.");
      }
    },
    "test-mcp-server": async (name: unknown, profile?: unknown): Promise<McpResult> => {
      assertProfile(ctx, profile);
      const target = find(name);
      if (!target) return { success: false, error: `MCP server "${String(name)}" not found.` };
      const mcp = ctx.kernel().mcp;
      if (!mcp) return { success: false, error: "MCP server testing is not available: plugin-mcp is disabled." };
      try {
        const tools = await mcp.probe(target);
        return { success: true, tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })) };
      } catch (err) {
        return failure(err, "Failed to test MCP server.");
      }
    },
    /**
     * V-14 : les outils que le serveur annonce MAINTENANT (connexion temporaire, rien d'enregistré), chacun avec sa place dans la
     * liste blanche et son état d'épingle. Le texte des descriptions est celui d'un tiers, nettoyé et tronqué par plugin-mcp.
     */
    "mcp-server-tools": async (name: unknown, profile?: unknown): Promise<McpToolsView> => {
      assertProfile(ctx, profile);
      const target = find(name);
      if (!target) return { success: false, error: `MCP server "${String(name)}" not found.` };
      const mcp = ctx.kernel().mcp;
      if (!mcp?.preview) return { success: false, error: "MCP server testing is not available: plugin-mcp is disabled." };
      try {
        const tools = await mcp.preview(target);
        return { success: true, restricted: !!target.allowedTools, allowed: target.allowedTools ? [...target.allowedTools] : null, tools: tools.map((t) => ({ name: t.name, description: t.description, allowed: t.allowed, pinState: t.pinState })) };
      } catch (err) {
        return { success: false, error: (err as Error)?.message || "Failed to read the MCP server's tools." };
      }
    },
    /**
     * V-14 : écrit la liste blanche (`null` = tous les outils), puis relance le serveur pour que le registre la suive. Des noms
     * d'outils seulement : au plus 500, 200 caractères chacun, sans caractère de contrôle ; doublons retirés.
     */
    "set-mcp-server-tools": async (name: unknown, tools: unknown, profile?: unknown): Promise<McpResult> => {
      assertProfile(ctx, profile);
      const target = find(name);
      if (!target) return { success: false, error: `MCP server "${String(name)}" not found.` };
      const allowed = toolList(tools);
      if (allowed === undefined) return { success: false, error: "tools must be null or a list of tool names." };
      const { allowedTools: _old, ...rest } = target;
      const next: McpServerConfig = allowed === null ? rest : { ...rest, allowedTools: allowed };
      try {
        return await save(
          servers().map((s) => (s.id === target.id ? next : s)),
          next,
        );
      } catch (err) {
        return failure(err, "Failed to update MCP server.");
      }
    },
    "list-mcp-catalog": (profile?: unknown) => {
      assertProfile(ctx, profile);
      return { entries: [], diagnostics: [], error: "Jarod-One n'a pas de catalogue MCP : ajoutez un serveur manuellement." };
    },
    "install-mcp-catalog-entry": (_name: unknown, _env?: unknown, profile?: unknown): McpResult => {
      assertProfile(ctx, profile);
      return { success: false, error: "Jarod-One n'a pas de catalogue MCP : ajoutez un serveur manuellement." };
    },
  };
}
