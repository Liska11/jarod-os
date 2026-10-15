// Passerelle compatible Hermes (essai) : les pages « Connexions » et « Réseau » de Herald — serveurs MCP et plateformes de messagerie. Traduction pure des
// réglages et de l'état de Jarod (`mcpServers`, `telegram`/`discord`/`slack`/`email`/`whatsapp`, `gatewayStatus`) dans la forme que lisent ces pages.
//
// Deux choix de prudence :
//  - les VALEURS des variables d'environnement d'un serveur MCP ne quittent pas le noyau (elles contiennent souvent des clés) : le shell voit les noms et « ••••• » ;
//  - activer une plateforme de messagerie est REFUSÉ d'ici : c'est ouvrir un canal par lequel des messages venus de l'extérieur pilotent l'agent, avec ses jetons
//    à fournir ; cela se fait dans l'écran « Passerelles » de Jarod, qui les demande.
import { redactKeyedText } from "@jarod/kernel/redact";
import { ConfigError } from "./config.js";

export interface McpConfigLike {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpStatusLike {
  id: string;
  state: "stopped" | "starting" | "running" | "error";
  error?: string;
  tools: string[];
}

export interface McpPort {
  list(): readonly McpStatusLike[];
  restart(config: McpConfigLike): Promise<void>;
  sync(configs: McpConfigLike[]): Promise<void>;
  probe(config: McpConfigLike): Promise<{ name: string; description?: string }[]>;
}

export const MASK = "•••••";

export function mcpServers(configs: readonly McpConfigLike[], statuses: readonly McpStatusLike[]): { servers: Record<string, unknown>[] } {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return {
    servers: configs.map((c) => {
      const st = byId.get(c.id);
      const remote = Boolean(c.url);
      return {
        name: c.name,
        transport: remote ? "http" : c.command ? "stdio" : "unknown",
        url: c.url ?? null,
        command: remote ? null : c.command || null,
        args: remote ? [] : c.args,
        env: Object.fromEntries(Object.keys(c.env ?? {}).map((k) => [k, MASK])),
        auth: remote && c.headers && Object.keys(c.headers).length > 0 ? "header" : "none",
        enabled: c.enabled,
        tools: null,
        // Ce que Jarod sait en plus (le shell l'ignore s'il ne le lit pas).
        state: st?.state ?? "stopped",
        ...(st?.error ? { error: st.error } : {}),
        running_tools: st?.tools.length ?? 0,
      };
    }),
  };
}

const find = (configs: readonly McpConfigLike[], name: string): McpConfigLike => {
  const hit = configs.find((c) => c.name === name);
  if (!hit) throw new ConfigError(`Serveur MCP inconnu : ${name}`);
  return hit;
};

/** Le nouvel ensemble de serveurs après activation ou coupure de `name` ; rend aussi le serveur modifié. */
export function setMcpEnabled(configs: readonly McpConfigLike[], name: string, enabled: unknown): { next: McpConfigLike[]; changed: McpConfigLike } {
  if (typeof enabled !== "boolean") throw new ConfigError("enabled doit être vrai ou faux");
  const target = find(configs, name);
  const changed = { ...target, enabled };
  return { next: configs.map((c) => (c.id === target.id ? changed : c)), changed };
}

export function removeMcp(configs: readonly McpConfigLike[], name: string): McpConfigLike[] {
  const target = find(configs, name);
  return configs.filter((c) => c.id !== target.id);
}

export function findMcp(configs: readonly McpConfigLike[], name: string): McpConfigLike {
  return find(configs, name);
}

/** Le résultat d'un essai de connexion, dans la forme du shell. */
export function probeResult(tools: readonly { name: string; description?: string }[] | Error): Record<string, unknown> {
  if (tools instanceof Error) return { ok: false, error: redactKeyedText(tools.message).slice(0, 200), tools: [] };
  return { ok: true, tools: tools.map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })) };
}

// --- plateformes de messagerie ---------------------------------------------------------------------------------

export type PlatformId = "telegram" | "discord" | "slack" | "email" | "whatsapp";

export const PLATFORMS: readonly { id: PlatformId; name: string; description: string }[] = [
  { id: "telegram", name: "Telegram", description: "Parler à l'agent depuis Telegram." },
  { id: "discord", name: "Discord", description: "Parler à l'agent depuis Discord." },
  { id: "slack", name: "Slack", description: "Parler à l'agent depuis Slack." },
  { id: "email", name: "E-mail", description: "Écrire à l'agent par e-mail." },
  { id: "whatsapp", name: "WhatsApp", description: "Parler à l'agent depuis WhatsApp." },
];

export interface GatewayStatusLike {
  state: "stopped" | "running" | "error";
  error?: string;
}

/**
 * Les plateformes avec leur état réel. « configured » veut dire « activée dans Jarod » : la présence des jetons dans le coffre n'est pas lue d'ici.
 * Une plateforme activée dont la passerelle n'a pas démarré est `gateway_stopped` ; en erreur, `startup_failed` avec le message.
 */
export function messagingPlatforms(setting: (id: PlatformId) => { enabled?: boolean } | undefined, status: (id: PlatformId) => GatewayStatusLike): { platforms: Record<string, unknown>[] } {
  return {
    platforms: PLATFORMS.map((p) => {
      const enabled = Boolean(setting(p.id)?.enabled);
      const st = status(p.id);
      const running = st.state === "running";
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        docs_url: null,
        enabled,
        configured: enabled,
        gateway_running: running,
        state: !enabled ? "disabled" : running ? null : st.state === "error" ? "startup_failed" : "gateway_stopped",
        error_code: st.state === "error" ? "error" : null,
        error_message: st.error ?? null,
        updated_at: null,
        env_vars: [],
      };
    }),
  };
}

export function refusePlatformToggle(id: string): never {
  throw new ConfigError(`${id} : l'activation d'une messagerie se fait dans l'écran « Passerelles » de Jarod, qui demande les jetons (elle ouvre un canal par lequel des messages extérieurs pilotent l'agent).`);
}
