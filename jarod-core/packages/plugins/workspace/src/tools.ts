/**
 * Outils d'espace de travail pour l'agent : worktree par tâche, diff, merge, et lancement d'un agent de code externe.
 * Les outils qui écrivent (créer un worktree, fusionner, lancer un agent) sont `dangerous` : l'utilisateur les approuve.
 */
import type { ToolDef } from "@jarod/plugin-tools";
import { runCliAgent, HARNESSES, type Harness } from "./cli-agent.js";
import { createTaskWorktree, mergeTaskBranch, taskDiff } from "./git.js";

const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`argument « ${key} » manquant`);
  return value;
};

export function workspaceTools(): ToolDef[] {
  return [
    {
      name: "worktree_create",
      description:
        "Crée une branche et un worktree git séparés pour une tâche, à partir du HEAD du dépôt. L'agent travaille ensuite dans ce worktree sans toucher au dépôt principal.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Chemin absolu du dépôt git principal." },
          branch: { type: "string", description: "Nom de la branche de la tâche, par exemple « feature/login »." },
        },
        required: ["repo", "branch"],
      },
      dangerous: true,
      source: "plugin",
      async run(args) {
        const created = await createTaskWorktree(str(args, "repo"), str(args, "branch"));
        return `Worktree créé : ${created.path} (branche ${created.branch}, depuis ${created.base.slice(0, 12)}).`;
      },
    },
    {
      name: "worktree_diff",
      description: "Liste les fichiers modifiés dans un worktree de tâche et rend leur diff (fichiers suivis, par rapport à HEAD).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Chemin absolu du worktree." } },
        required: ["path"],
      },
      dangerous: false,
      source: "plugin",
      async run(args) {
        const diff = await taskDiff(str(args, "path"));
        if (!diff.files.length) return "Aucun changement dans ce worktree.";
        const list = diff.files.map((f) => `${f.status} ${f.path}`).join("\n");
        const note = diff.truncated ? "\n\n[diff coupé : trop long]" : "";
        return `${diff.files.length} fichier(s) :\n${list}\n\n${diff.patch}${note}`;
      },
    },
    {
      name: "worktree_merge",
      description:
        "Fusionne la branche d'une tâche dans la branche courante du dépôt principal (merge sans avance rapide). Refuse si le dépôt principal a des changements non commités, et annule le merge en cas de conflit.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Chemin absolu du dépôt git principal." },
          branch: { type: "string", description: "Branche de la tâche à fusionner." },
        },
        required: ["repo", "branch"],
      },
      dangerous: true,
      source: "plugin",
      async run(args) {
        const merged = await mergeTaskBranch(str(args, "repo"), str(args, "branch"));
        return `Branche ${str(args, "branch")} fusionnée dans ${merged.into} (HEAD ${merged.head.slice(0, 12)}).`;
      },
    },
    {
      name: "cli_agent_run",
      description: `Confie une tâche de code à un agent installé sur cette machine (${HARNESSES.join(", ")}), dans un dossier donné, et rend sa réponse. L'agent modifie les fichiers de ce dossier.`,
      parameters: {
        type: "object",
        properties: {
          harness: { type: "string", enum: [...HARNESSES], description: "claude = Claude Code, codex = Codex CLI." },
          cwd: { type: "string", description: "Chemin absolu du dossier de travail (de préférence un worktree de tâche)." },
          prompt: { type: "string", description: "La tâche à confier, complète et autonome." },
          model: { type: "string", description: "Modèle optionnel, tel que l'agent le connaît." },
        },
        required: ["harness", "cwd", "prompt"],
      },
      dangerous: true,
      source: "plugin",
      async run(args) {
        const harness = str(args, "harness");
        if (!HARNESSES.includes(harness as Harness)) throw new Error(`agent inconnu : ${harness}`);
        const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
        const result = await runCliAgent({ harness: harness as Harness, cwd: str(args, "cwd"), prompt: str(args, "prompt"), ...(model ? { model } : {}) });
        const cost = result.costUsd !== undefined ? `\nCoût rapporté : $${result.costUsd.toFixed(4)}` : "";
        if (!result.ok) return `Échec de ${harness} : ${result.error}\n${result.stderr}`.trim() + (result.text ? `\n\n${result.text}` : "");
        return `${result.text || "(réponse vide)"}${cost}`;
      },
    },
  ];
}
