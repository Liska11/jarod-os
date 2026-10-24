/**
 * @jarod/plugin-workspace — espace de travail par tâche (repris de PandaCode) : worktree git par tâche, diff, merge,
 * et lancement d'un agent de code installé (Claude Code, Codex CLI). Enregistre ses outils dans `ctx.tools.registry`.
 */
import type {} from "@jarod/plugin-tools";
import type { Context } from "cordis";
import { workspaceTools } from "./tools.js";

export * from "./cli-agent.js";
export * from "./git.js";
export * from "./tools.js";

export const name = "workspace";
export const inject = ["tools"];

export function apply(ctx: Context): void {
  for (const tool of workspaceTools()) {
    ctx.effect(() => ctx.tools.registry.register(tool), `workspace:${tool.name}`);
  }
}
