/**
 * Espace de code (page « Workspace » de la fenêtre) : canaux PROPRES à Jarod (`JAROD_INVOKE_CHANNELS`, absents de hermesAPI), sur plugin-workspace.
 * Worktrees par tâche, diff, merge, agents de code externes (Claude Code, Codex CLI) et vue GitHub.
 *
 * - Le renderer ne tape jamais de chemin : le dépôt vient de `select-folder` (boîte native) et passe la garde `bindable` à CHAQUE appel ; un worktree
 *   n'est accepté que s'il figure dans `git worktree list` de ce dépôt (jamais un chemin libre).
 * - Ce qui écrit ou dépense (créer un worktree, fusionner, lancer un agent) demande une confirmation NATIVE ; « Annuler » par défaut. Sans boîte
 *   native (mode sans fenêtre), c'est un refus, jamais un accord implicite.
 * - Un agent de code externe n'est lancé que dans un worktree de tâche, jamais dans le dépôt principal.
 */
import { findOnPath } from "@jarod/kernel/find-on-path";
import {
  agentBusy,
  createTaskWorktree,
  HARNESSES,
  type Harness,
  launchFor,
  listIssues,
  listPulls,
  listWorktrees,
  mergeTaskBranch,
  requireWorktree,
  runCliAgent,
  taskDiff,
  viewPull,
} from "@jarod/plugin-workspace";
import type { FileGate } from "../file-gate.js";
import type { HandlerContext } from "./context.js";

const AGENT_NAMES: Record<Harness, string> = { claude: "Claude Code", codex: "Codex CLI" };
const AGENT_BINARIES: Record<Harness, string> = { claude: "claude", codex: "codex" };
const KINDS = ["prs", "issues"] as const;

/** Combien de la tâche la boîte de confirmation montre : de quoi relire l'essentiel, sans noyer le bouton. */
export const PROMPT_PREVIEW_CHARS = 2000;

/** La tâche telle que la confirmation la montre : tronquée si elle est longue, toujours avec sa longueur totale. */
export function promptPreview(task: string): string {
  const shown = task.length > PROMPT_PREVIEW_CHARS ? `${task.slice(0, PROMPT_PREVIEW_CHARS)}\n[… tronquée]` : task;
  return `Tâche envoyée (${task.length} caractères) :\n${shown}`;
}

function text(value: unknown, name: string, max = 200_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`[oneai] ${name} : valeur manquante`);
  if (value.length > max) throw new Error(`[oneai] ${name} : valeur trop longue`);
  return value;
}

export function createCodespaceHandlers(ctx: HandlerContext, gate: FileGate) {
  const repoOf = (channel: string, repo: unknown): string => gate.bindable(channel, repo);

  /** Confirmation native, « Annuler » par défaut. Sans boîte native : refusé. */
  const confirm = async (title: string, message: string, okLabel: string): Promise<boolean> => {
    if (!ctx.shell.confirm) throw new Error("[oneai] confirmation native indisponible, refusé");
    return ctx.shell.confirm(title, message, okLabel);
  };

  return {
    /** Les agents de code installés sur la machine (chemin trouvé dans le PATH), sans les lancer. */
    "codespace-agents": (): { id: Harness; name: string; path: string | null }[] =>
      HARNESSES.map((id) => ({ id, name: AGENT_NAMES[id], path: findOnPath(AGENT_BINARIES[id]) })),

    "codespace-worktrees": async (repo: unknown) => listWorktrees(repoOf("codespace-worktrees", repo)),

    "codespace-create-worktree": async (repo: unknown, branch: unknown) => {
      const real = repoOf("codespace-create-worktree", repo);
      const name = text(branch, "branche", 120);
      const ok = await confirm("Créer un worktree ?", `Une branche « ${name} » et un dossier séparé seront créés à côté de ${real}. Le dépôt principal n'est pas modifié.`, "Créer");
      if (!ok) return null;
      return createTaskWorktree(real, name);
    },

    "codespace-diff": async (repo: unknown, path: unknown) => {
      const real = repoOf("codespace-diff", repo);
      const worktree = await requireWorktree(real, text(path, "worktree", 4096));
      return taskDiff(worktree.path);
    },

    "codespace-merge": async (repo: unknown, branch: unknown) => {
      const real = repoOf("codespace-merge", repo);
      const name = text(branch, "branche", 120);
      const ok = await confirm("Fusionner la tâche ?", `La branche « ${name} » sera fusionnée dans la branche courante de ${real} (merge sans avance rapide). En cas de conflit, le merge est annulé.`, "Fusionner");
      if (!ok) return null;
      return mergeTaskBranch(real, name);
    },

    /** Lance Claude Code ou Codex dans un worktree de tâche. Rend la réponse de l'agent quand il a fini (peut durer plusieurs minutes). */
    "codespace-run-agent": async (repo: unknown, path: unknown, harness: unknown, prompt: unknown, model?: unknown) => {
      const real = repoOf("codespace-run-agent", repo);
      if (typeof harness !== "string" || !HARNESSES.includes(harness as Harness)) throw new Error(`[oneai] agent inconnu : ${String(harness)}`);
      const agent = harness as Harness;
      const worktree = await requireWorktree(real, text(path, "worktree", 4096));
      if (worktree.main) throw new Error("[oneai] un agent de code se lance dans un worktree de tâche, pas dans le dépôt principal");
      const task = text(prompt, "tâche");
      const modelName = typeof model === "string" && model.trim() ? model.trim() : undefined;
      // Tout ce qui peut être refusé l'est AVANT la boîte : la confirmation porte sur les paramètres exacts qui seront exécutés.
      launchFor(agent, modelName);
      if (agentBusy(worktree.path)) throw new Error(`[oneai] un agent travaille déjà dans ${worktree.path} : attendez qu'il ait fini`);
      const ok = await confirm(
        `Lancer ${AGENT_NAMES[agent]} ?`,
        `${AGENT_NAMES[agent]} va modifier les fichiers de ${worktree.path} avec votre compte, sans demander à chaque fichier.\nModèle : ${modelName ?? "celui de l'agent"}\n\n${promptPreview(task)}`,
        "Lancer",
      );
      if (!ok) return null;
      return runCliAgent({ harness: agent, cwd: worktree.path, prompt: task, ...(modelName ? { model: modelName } : {}) });
    },

    /** Pull requests ou issues du dépôt, via `gh` (déjà connecté sur la machine). */
    "codespace-github-list": async (repo: unknown, kind: unknown, state?: unknown) => {
      const real = repoOf("codespace-github-list", repo);
      if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) throw new Error(`[oneai] genre inconnu : ${String(kind)}`);
      const options = { cwd: real, ...(typeof state === "string" ? { state } : {}), limit: 30 };
      return kind === "issues" ? listIssues(options) : listPulls(options);
    },

    "codespace-github-pr": async (repo: unknown, number: unknown) => {
      const real = repoOf("codespace-github-pr", repo);
      if (typeof number !== "number") throw new Error("[oneai] numéro de PR manquant");
      return viewPull(number, { cwd: real });
    },
  };
}
