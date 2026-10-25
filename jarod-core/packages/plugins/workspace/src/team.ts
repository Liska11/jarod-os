/**
 * Équipe d'agents (repris de PandaCode) : l'architecte, c'est l'agent appelant, découpe le travail en tâches ; chaque
 * tâche devient un worker de code (Claude Code ou Codex) dans son propre worktree. Les workers tournent en parallèle.
 * Rien n'est fusionné ici : chaque branche se relit, puis se fusionne par `worktree_merge`.
 */
import { runCliAgent, launchFor, type Harness, type Launch } from "./cli-agent.js";
import { createTaskWorktree, taskDiff, WorkspaceError, type TaskWorktree } from "./git.js";

export const MAX_WORKERS = 3;

export interface TeamTask {
  branch: string;
  harness: Harness;
  prompt: string;
  model?: string;
}

export interface TeamWorker {
  branch: string;
  path: string;
  harness: Harness;
  ok: boolean;
  text: string;
  error?: string;
  changedFiles: number;
  costUsd?: number;
}

export interface TeamOptions {
  /** Commande de chaque agent : injectable pour les tests. Par défaut, celle des variables d'environnement. */
  launch?: (harness: Harness, model: string | undefined) => Launch;
}

export async function runTeam(repo: string, tasks: TeamTask[], options: TeamOptions = {}): Promise<TeamWorker[]> {
  if (tasks.length < 1 || tasks.length > MAX_WORKERS) throw new WorkspaceError(`une équipe compte de 1 à ${MAX_WORKERS} workers`);
  const branches = new Set(tasks.map((t) => t.branch));
  if (branches.size !== tasks.length) throw new WorkspaceError("deux workers ne peuvent pas partager une branche");
  for (const task of tasks) {
    if (!task.prompt.trim()) throw new WorkspaceError(`prompt vide pour la branche ${task.branch}`);
    launchFor(task.harness, task.model); // modèle refusé : on le sait avant de créer le moindre worktree
  }

  // Les worktrees se créent l'un après l'autre (git verrouille le dépôt), puis les agents tournent ensemble.
  const created: TaskWorktree[] = [];
  for (const task of tasks) created.push(await createTaskWorktree(repo, task.branch));

  return Promise.all(
    tasks.map(async (task, i): Promise<TeamWorker> => {
      const worktree = created[i]!;
      const launch = options.launch ? options.launch(task.harness, task.model) : undefined;
      const result = await runCliAgent(
        { harness: task.harness, cwd: worktree.path, prompt: task.prompt, ...(task.model ? { model: task.model } : {}) },
        launch ?? launchFor(task.harness, task.model),
      );
      const diff = await taskDiff(worktree.path).catch(() => ({ files: [] }));
      return {
        branch: task.branch,
        path: worktree.path,
        harness: task.harness,
        ok: result.ok,
        text: result.text,
        changedFiles: diff.files.length,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      };
    }),
  );
}
