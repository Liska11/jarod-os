/**
 * @jarod/plugin-workspace — espace de travail (repris de PandaCode) : worktree git par tâche, diff, merge, agents de code
 * externes (Claude Code, Codex CLI), équipes de workers en parallèle, vue GitHub (gh), déploiements à approbation, et
 * simulateurs iOS/Android. Enregistre ses outils dans `ctx.tools.registry`.
 */
import type {} from "@jarod/plugin-tools";
import type { Context } from "cordis";
import { workspaceTools } from "./tools.js";

export * from "./cli-agent.js";
export * from "./deploy.js";
export * from "./exec.js";
export * from "./git.js";
export * from "./github.js";
export * from "./simulator.js";
export * from "./team.js";
export * from "./tools.js";

export const name = "workspace";
export const inject = ["tools"];

export function apply(ctx: Context): void {
  for (const tool of workspaceTools()) {
    ctx.effect(() => ctx.tools.registry.register(tool), `workspace:${tool.name}`);
  }
}
