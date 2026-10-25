/**
 * Outils d'espace de travail pour l'agent. Les outils qui écrivent ou qui touchent à l'extérieur (créer un worktree,
 * fusionner, lancer un agent, ouvrir une PR, déployer, capturer un écran, lancer une équipe) sont `dangerous` :
 * l'utilisateur les approuve, et le libellé d'approbation dit ce qui va se passer.
 */
import type { ToolDef } from "@jarod/plugin-tools";
import { runCliAgent, HARNESSES, type Harness } from "./cli-agent.js";
import { DEPLOY_PROVIDERS, deployDescription, runDeploy, type DeployOptions } from "./deploy.js";
import { createPull, listIssues, listPulls, viewPull } from "./github.js";
import { createTaskWorktree, mergeTaskBranch, taskDiff } from "./git.js";
import { listSimulators, PLATFORMS, screenshot, type Platform } from "./simulator.js";
import { MAX_WORKERS, runTeam, type TeamTask } from "./team.js";

const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`argument « ${key} » manquant`);
  return value;
};

const optStr = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
};

/** Worktrees et diff : la base de l'espace de travail par tâche. */
function gitTools(): ToolDef[] {
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
  ];
}

/** Un agent de code installé, dans un dossier donné. */
function agentTools(): ToolDef[] {
  return [
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
        const model = optStr(args, "model");
        const result = await runCliAgent({ harness: harness as Harness, cwd: str(args, "cwd"), prompt: str(args, "prompt"), ...(model ? { model } : {}) });
        const cost = result.costUsd !== undefined ? `\nCoût rapporté : $${result.costUsd.toFixed(4)}` : "";
        if (!result.ok) return `Échec de ${harness} : ${result.error}\n${result.stderr}`.trim() + (result.text ? `\n\n${result.text}` : "");
        return `${result.text || "(réponse vide)"}${cost}`;
      },
    },
    {
      name: "team_run",
      description: `Lance une équipe : jusqu'à ${MAX_WORKERS} agents de code en parallèle, chacun dans son propre worktree (une branche par tâche). Rend le résultat de chacun. Rien n'est fusionné : relisez chaque branche, puis fusionnez-la avec worktree_merge.`,
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Chemin absolu du dépôt git principal." },
          tasks: {
            type: "array",
            maxItems: MAX_WORKERS,
            items: {
              type: "object",
              properties: {
                branch: { type: "string" },
                harness: { type: "string", enum: [...HARNESSES] },
                prompt: { type: "string" },
                model: { type: "string" },
              },
              required: ["branch", "harness", "prompt"],
            },
          },
        },
        required: ["repo", "tasks"],
      },
      dangerous: true,
      source: "plugin",
      precheck(args) {
        const tasks = Array.isArray(args.tasks) ? (args.tasks as { branch?: unknown }[]) : [];
        return `Lancer ${tasks.length} agent(s) en parallèle sur ${String(args.repo)} (branches : ${tasks.map((t) => String(t.branch)).join(", ")})`;
      },
      async run(args) {
        const tasks = (Array.isArray(args.tasks) ? args.tasks : []).map((raw): TeamTask => {
          const t = raw as Record<string, unknown>;
          const harness = str(t, "harness");
          if (!HARNESSES.includes(harness as Harness)) throw new Error(`agent inconnu : ${harness}`);
          const model = optStr(t, "model");
          return { branch: str(t, "branch"), harness: harness as Harness, prompt: str(t, "prompt"), ...(model ? { model } : {}) };
        });
        const workers = await runTeam(str(args, "repo"), tasks);
        return workers
          .map((w) => {
            const status = w.ok ? "ok" : `échec : ${w.error}`;
            const cost = w.costUsd !== undefined ? `, coût $${w.costUsd.toFixed(4)}` : "";
            return `## ${w.branch} (${w.harness}) — ${status} — ${w.changedFiles} fichier(s) modifié(s)${cost}\nWorktree : ${w.path}\n\n${w.text || "(réponse vide)"}`;
          })
          .join("\n\n");
      },
    },
  ];
}

/** Pull requests et issues GitHub, via `gh`. */
function githubTools(): ToolDef[] {
  const repoProp = { type: "string", description: "Dépôt GitHub « propriétaire/nom ». Sans lui : le dépôt du dossier courant." };
  return [
    {
      name: "github_list",
      description: "Liste les pull requests ou les issues d'un dépôt GitHub (via le CLI gh).",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["prs", "issues"] },
          repo: repoProp,
          state: { type: "string", enum: ["open", "closed", "merged", "all"] },
          limit: { type: "number", description: "Nombre maximal d'éléments (1 à 100, 20 par défaut)." },
        },
        required: ["kind"],
      },
      dangerous: false,
      source: "plugin",
      async run(args) {
        const options = { repo: optStr(args, "repo"), state: optStr(args, "state"), limit: num(args, "limit") };
        const rows = str(args, "kind") === "issues" ? await listIssues(options) : await listPulls(options);
        return rows.length ? JSON.stringify(rows, null, 2) : "Aucun élément.";
      },
    },
    {
      name: "github_pr_view",
      description: "Affiche une pull request GitHub : titre, description, branches, revue et mergeabilité.",
      parameters: {
        type: "object",
        properties: { number: { type: "number" }, repo: repoProp },
        required: ["number"],
      },
      dangerous: false,
      source: "plugin",
      async run(args) {
        const number = num(args, "number");
        if (number === undefined) throw new Error("argument « number » manquant");
        return JSON.stringify(await viewPull(number, { ...(optStr(args, "repo") ? { repo: optStr(args, "repo")! } : {}) }), null, 2);
      },
    },
    {
      name: "github_pr_create",
      description: "Ouvre une pull request depuis la branche courante (ou `head`) vers `base`. Rend l'URL de la PR.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string", description: "Description de la PR." },
          base: { type: "string", description: "Branche de destination, par exemple « main »." },
          head: { type: "string", description: "Branche source. Sans elle : la branche courante." },
          repo: repoProp,
          cwd: { type: "string", description: "Chemin absolu du dépôt ou du worktree qui porte la branche." },
        },
        required: ["title", "body"],
      },
      dangerous: true,
      source: "plugin",
      precheck(args) {
        return `Ouvrir une PR « ${String(args.title)} » vers ${String(args.base ?? "la branche par défaut")}`;
      },
      async run(args) {
        const url = await createPull({
          title: str(args, "title"),
          body: typeof args.body === "string" ? args.body : "",
          ...(optStr(args, "base") ? { base: optStr(args, "base")! } : {}),
          ...(optStr(args, "head") ? { head: optStr(args, "head")! } : {}),
          ...(optStr(args, "repo") ? { repo: optStr(args, "repo")! } : {}),
          ...(optStr(args, "cwd") ? { cwd: optStr(args, "cwd")! } : {}),
        });
        return `Pull request ouverte : ${url}`;
      },
    },
  ];
}

/** Déploiement d'un projet vers un fournisseur, avec approbation nommée. */
function deployTools(): ToolDef[] {
  return [
    {
      name: "deploy_run",
      description: `Déploie un projet vers un fournisseur (${DEPLOY_PROVIDERS.join(", ")}) avec son CLI installé. production=false fait un aperçu quand le fournisseur le permet.`,
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: [...DEPLOY_PROVIDERS] },
          cwd: { type: "string", description: "Chemin absolu du projet à déployer." },
          production: { type: "boolean", description: "true pour la production ; false (défaut) pour un aperçu." },
        },
        required: ["provider", "cwd"],
      },
      dangerous: true,
      source: "plugin",
      precheck(args) {
        return deployDescription(deployOf(args));
      },
      async run(args) {
        const result = await runDeploy(deployOf(args));
        const out = result.stdout.toString("utf8").trim();
        if (result.error || result.code !== 0) return `Déploiement échoué : ${result.error ?? result.stderr}\n${out}`.trim();
        return out || "Déploiement terminé.";
      },
    },
  ];
}

function deployOf(args: Record<string, unknown>): DeployOptions {
  return { provider: str(args, "provider"), cwd: str(args, "cwd"), production: args.production === true };
}

/** Simulateurs iOS et émulateurs Android pour les agents. */
function simulatorTools(): ToolDef[] {
  return [
    {
      name: "simulator_list",
      description: "Liste les simulateurs iOS (xcrun simctl) et les appareils Android (adb) disponibles, avec leur identifiant et leur état.",
      parameters: { type: "object", properties: {} },
      dangerous: false,
      source: "plugin",
      async run() {
        const listed = await listSimulators();
        const lines = (["ios", "android"] as const).map((p) => {
          const l = listed[p];
          if (l.error) return `${p} : indisponible (${l.error})`;
          return `${p} : ${l.devices.length ? l.devices.map((d) => `${d.name} [${d.id}] ${d.state}`).join(" ; ") : "aucun appareil"}`;
        });
        return lines.join("\n");
      },
    },
    {
      name: "simulator_screenshot",
      description: "Capture l'écran d'un simulateur iOS ou d'un appareil Android dans un fichier PNG.",
      parameters: {
        type: "object",
        properties: {
          platform: { type: "string", enum: [...PLATFORMS] },
          device: { type: "string", description: "Identifiant de l'appareil (voir simulator_list). Sans lui : l'appareil démarré ou l'unique appareil." },
          out: { type: "string", description: "Chemin absolu du fichier .png à écrire." },
        },
        required: ["platform", "out"],
      },
      dangerous: true,
      source: "plugin",
      precheck(args) {
        return `Capturer l'écran ${String(args.platform)} vers ${String(args.out)}`;
      },
      async run(args) {
        const out = await screenshot({
          platform: str(args, "platform") as Platform,
          out: str(args, "out"),
          ...(optStr(args, "device") ? { device: optStr(args, "device")! } : {}),
        });
        return `Capture écrite : ${out}`;
      },
    },
  ];
}

export function workspaceTools(): ToolDef[] {
  return [...gitTools(), ...agentTools(), ...githubTools(), ...deployTools(), ...simulatorTools()];
}
