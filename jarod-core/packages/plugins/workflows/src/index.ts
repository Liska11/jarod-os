/**
 * @jarod/plugin-workflows — plugins utilisateur ISOLÉS (U2, gap G6 ; PLAN §2 range `plugins` ici).
 * Câblage `core.ts:360-366,392,658,661,1787` (rév. 2e180305) : `PluginHost(<dataDir>/plugins, tools,
 * commands, settings, notifications)`, routes servies par le routeur du cœur, `seed()` puis `reload()`
 * au démarrage, `unloadAll()` à l'arrêt. L'hôte remplace le port `plugins` du runtime d'agent
 * (`attachPlugins`) : `beforeSend`/`afterResponse` et `/status` passent par lui.
 * Config : `seed`, `load` (défaut vrai ; le CLI sans `init()` les coupe), `spawn` (desktop :
 * utilityProcess), `callTimeoutMs`.
 */
import { join } from "node:path";
import type { AgentRuntime } from "@jarod/plugin-agent";
import type {} from "@jarod/plugin-llm";
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { type IsolateSpawner, PluginHost } from "./plugins.js";

export * from "./plugins.js";

declare module "cordis" {
  interface Context {
    pluginHost: PluginHost;
  }
}

export interface WorkflowsConfig {
  seed?: boolean;
  load?: boolean;
  spawn?: IsolateSpawner;
  callTimeoutMs?: number;
  activateTimeoutMs?: number;
}

export const name = "workflows";
export const inject = ["storage", "llm", "agent"];

/** `/plugin` : liste, trust, distrust. Le texte dit ce qui est réellement enregistré, pas ce que le plugin prétend. */
function pluginCommand(host: PluginHost, runtime: AgentRuntime, args: string): string {
  const [sub = "list", id, ...names] = args.trim().split(/\s+/).filter(Boolean);
  if (sub === "trust" || sub === "distrust") {
    if (!id) return `Usage : /plugin ${sub} <id> [outil…]`;
    try {
      const done = sub === "trust" ? host.trustTools(id, names) : host.distrustTools(id, names);
      const digest = host.list().find((p) => p.id === id)?.digest.slice(0, 12) ?? "";
      return sub === "trust"
        ? `**${id}** : ${done.map((t) => `\`${t}\``).join(", ") || "aucun outil"} — désormais SANS accord, pour le contenu actuel du plugin (empreinte ${digest}). Toute modification du plugin retire ce classement.`
        : `**${id}** : ${done.map((t) => `\`${t}\``).join(", ") || "aucun outil"} — l'accord est de nouveau demandé à chaque appel.`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (sub !== "list") return "Usage : /plugin [list] · /plugin trust <id> [outil…] · /plugin distrust <id> [outil…]";
  const plugins = host.list();
  if (!plugins.length) return "Aucun plugin.";
  return [
    "**Plugins** — l'accord est fixé par VOUS ; ce que le plugin déclare n'est qu'une indication.",
    ...plugins.flatMap((p) => [
      `- \`${p.id}\` — ${p.name} ${p.version} · ${p.state}${p.digest ? ` · empreinte ${p.digest.slice(0, 12)}` : ""}${p.error ? ` · ${p.error}` : ""}`,
      ...p.tools.map((t) => {
        const tool = runtime.tools.get(t) as (ReturnType<typeof runtime.tools.get> & { declaredDangerous?: boolean }) | undefined;
        return `  - \`${t}\` : ${p.trusted.includes(t) ? "SANS accord (classé par vous)" : "accord à chaque appel"}${tool?.declaredDangerous ? " · le plugin le dit dangereux" : ""}`;
      }),
    ]),
  ].join("\n");
}

export async function apply(ctx: Context, config: WorkflowsConfig = {}): Promise<void> {
  const runtime = (ctx as unknown as { agent: AgentRuntime }).agent;
  const host = new PluginHost(join(ctx.storage.dataDir, "plugins"), runtime.tools, runtime.commands, ctx.storage.settings, ctx.storage.notifications, {
    ...(config?.spawn ? { spawn: config.spawn } : {}),
    ...(config?.callTimeoutMs ? { callTimeoutMs: config.callTimeoutMs } : {}),
    ...(config?.activateTimeoutMs ? { activateTimeoutMs: config.activateTimeoutMs } : {}),
  });
  // Q19-4 : le classement « sans accord » d'un outil de plugin est le fait de l'utilisateur, dans le composer. `list` seul est
  // sans effet ; `trust` et `distrust` en ont un : le garde des commandes distantes (passerelles) les refuse (Q19-2).
  const offCommand = runtime.commands.register({
    name: "plugin",
    description: "Plugins : la liste, et le classement de leurs outils (sans accord ou accord à chaque appel)",
    usage: "/plugin [list] · /plugin trust <id> [outil…] · /plugin distrust <id> [outil…]",
    source: "builtin",
    readOnly: (args) => ["", "list"].includes(args.trim()),
    run: (args) => ({ text: pluginCommand(host, runtime, args) }),
  });
  // Un plugin qui déclare une route doit pouvoir être JOINT : le routeur du cœur (core.ts:388-392).
  host.attachRouter(ctx.llm.router);
  const detach = runtime.attachPlugins(host);
  ctx.effect(
    () => async () => {
      offCommand();
      detach();
      await host.unloadAll();
    },
    "workflows:plugins",
  );
  ctx.provide("pluginHost", host);
  if (config?.seed ?? true) await host.seed();
  if (config?.load ?? true) await host.reload();
}
