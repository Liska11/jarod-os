/**
 * @jarod/plugin-agent — `ctx.agent` : la boucle d'agent (`agent.ts`) et son runtime de tours
 * (`runtime.ts`, port de `JarodCore`). Câblage repris de `core.ts:353-354,472,536-555,567-633,683`
 * pour les familles d'outils liées à l'agent, les commandes, les tâches planifiées.
 */
import type {} from "@jarod/plugin-llm";
import { taskStatusTool } from "./tasks.js";
import { outputTools } from "./outputs.js";
import { artifactTools } from "./artifacts.js";
import { videoTools } from "./video.js";
import { staticAnalysisTools } from "./static-analysis.js";
import type {} from "@jarod/plugin-memory";
import type {} from "@jarod/plugin-permissions";
import type {} from "@jarod/plugin-persona";
import type {} from "@jarod/plugin-rag";
import type {} from "@jarod/plugin-scheduler";
import { WebhookRunner } from "@jarod/plugin-scheduler";
import type {} from "@jarod/plugin-skills";
import type {} from "@jarod/plugin-storage";
import { CuratorService } from "@jarod/plugin-memory";
import { presentTools, resolveInWorkspace, skillTools, toolSearchTools } from "@jarod/plugin-tools";
import type {} from "@jarod/plugin-vision";
import type { Context } from "cordis";
import { registerAgentCommands } from "./builtin-commands.js";
import { cronTools } from "./cron-tools.js";
import { LearningService } from "./learning.js";
import { AgentRuntime, noPlugins, type TurnOutcome } from "./runtime.js";
import { acquireRuntimeLock, type RuntimeMode } from "./runtime-lock.js";
import { MessageService, SessionService } from "./sessions.js";
import { RefineService, refineTools } from "./refine.js";
import { rlmTools } from "./rlm.js";
import { sessionStateTools } from "./session-state.js";
import { sessionTools } from "./sessions-tools.js";
import { registerSkillCommands } from "./skills-commands.js";
import { permissionsExplainTool } from "./permissions-tool.js";

export * from "./access-profile.js";
export * from "./agent.js";
export * from "./builtin-commands.js";
export * from "./commands.js";
export * from "./cron-tools.js";
export * from "./learning.js";
export * from "./loop-guards.js";
export * from "./never-always.js";
export * from "./runtime.js";
export * from "./runtime-lock.js";
export * from "./sessions.js";
export * from "./sessions-tools.js";
export * from "./skills-commands.js";
export * from "./spill.js";
export * from "./subagents.js";
export * from "./supervisor.js";
export * from "./tasks.js";
export * from "./outputs.js";
export * from "./artifacts.js";
export * from "./video.js";
export * from "./static-analysis.js";

declare module "cordis" {
  interface Context {
    agent: AgentRuntime;
  }
}

export const name = "agent";
export const inject = {
  storage: { required: true },
  memory: { required: true },
  llm: { required: true },
  rag: { required: true },
  skills: { required: true },
  skillsHub: { required: true },
  tools: { required: true },
  permissions: { required: true },
  scheduler: { required: true },
  // WebhookRunner lit ctx.jobs (fourni par plugin-scheduler) : déclaré ici, sinon cordis refuse l'accès.
  jobs: { required: true },
  vision: { required: false },
  mcp: { required: false },
  persona: { required: false },
};

export interface AgentConfig {
  /** Version annoncée (`/version`, API) — `CoreOptions.appVersion`, défaut "0.1.0". */
  appVersion?: string;
  /** Qui sert ce profil (`CoreOptions.runtimeMode`, défaut "desktop") : un seul processus vivant par profil. */
  runtimeMode?: RuntimeMode;
  /**
   * Prendre le verrou du profil (défaut : oui) — c'est ce que faisait `init()`. Le CLI (`ask`,
   * `sessions`…) ouvrait le cœur SANS `init()` : il passe `false` et cohabite avec le desktop.
   */
  runtimeLock?: boolean;
  /** Minuteur horaire du curator (défaut : oui, comme `init()`) ; le CLI passe `false`. */
  curatorTimer?: boolean;
}

export function apply(ctx: Context, config: AgentConfig = {}): void {
  const { db, settings, events, checkpoints, notifications } = ctx.storage;
  const tools = ctx.tools.registry;
  const sessions = new SessionService(db);
  // Annotation EXPLICITE : `runtime` est référencé dans son propre initialiseur (le callback du
  // garde lit `runtime.commands`). Sans elle, l'inférence ne converge pas quand ce fichier est
  // atteint depuis un autre programme de type (automation → agent) : TS7022.
  const runtime: AgentRuntime = new AgentRuntime({
    db,
    settings,
    events,
    checkpoints,
    notifications,
    sessions,
    messages: new MessageService(db, sessions),
    memory: ctx.memory.memory,
    userProfile: ctx.memory.userProfile,
    providers: ctx.llm.providers,
    routing: ctx.llm.routing,
    tools,
    toolSearch: ctx.tools.toolSearch,
    skills: ctx.skills,
    attachments: ctx.rag.attachments,
    vault: ctx.rag.vault,
    ...(ctx.get("vision") ? { vision: ctx.vision } : {}),
    ...(ctx.get("persona") ? { persona: ctx.persona } : {}),
    plugins: noPlugins,
    // Garde unifié : règles utilisateur, puis « déclaré au registre → allow », puis `* → deny`.
    // Les commandes `/` d'un canal distant y passent sous le nom `command/<nom>` (Q19-2).
    gate: ctx.permissions.gate((name) =>
      name.startsWith("command/") ? runtime.commands.has(name.slice("command/".length)) : Boolean(tools.get(name)),
    ),
    appVersion: config?.appVersion ?? "0.1.0",
    emit: (name, ...args) => ctx.emit(name as never, ...(args as never[])),
  });

  // Before an edit, keep the file's content for /rewind (core.ts:536-551 ; la note LSP après
  // l'édition arrive avec le service LSP).
  for (const toolName of ["write_file", "edit_file"]) {
    const tool = tools.get(toolName);
    if (!tool) continue;
    const run = tool.run.bind(tool);
    tool.run = async (args, tctx) => {
      if (tctx.workspace && runtime.sessions.get(tctx.sessionId)) {
        try {
          runtime.checkpoints.capture(tctx.sessionId, resolveInWorkspace(tctx, args.path));
        } catch {
          /* invalid path: the tool itself reports it */
        }
      }
      return run(args, tctx);
    };
  }
  // Autonomie configurable (2026-10-21) : l'agent LIT ses permissions (jamais ne les écrit) pour expliquer un refus ou un accord demandé.
  tools.register(permissionsExplainTool(tools, () => runtime.gate, () => {
    ctx.permissions.refresh();
    return ctx.permissions.guard.getRules();
  }));
  // core.ts:553-566
  tools.register({
    name: "delegate_task",
    description:
      "Confie une tâche de recherche ou d'analyse autonome à un sous-agent (outils en lecture seule, contexte séparé) et renvoie son compte rendu. Utile pour explorer beaucoup de fichiers ou de pages sans encombrer la conversation.",
    parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    source: "builtin",
    run: (args, tctx) =>
      runtime.subagents.run(
        String(args.task),
        tctx.sessionId,
        (task, signal) => runtime.agent.runSubAgent(task, signal, tctx.sessionId),
        tctx.signal,
      ),
  });
  // Jarod-cordis (Q18) : la compaction à la demande du MODÈLE (SANK-AI `plugin context-compaction`, outil
  // `compact`, MIT), sur le mécanisme persistant de Jarod (`Agent.compact` : originaux gardés `compacted`).
  // `dangerous` : l'utilisateur approuve (l'historique affiché change), et les sous-agents ne l'ont pas.
  tools.register({
    name: "compact",
    description:
      "Résume les anciens échanges de la conversation pour libérer du contexte (les deux derniers échanges restent intacts). `preserve` : ce que le résumé doit garder en priorité (ex. « les tests qui échouent »).",
    parameters: {
      type: "object",
      properties: { preserve: { type: "string", description: "Ce qu'il faut préserver en priorité" } },
    },
    dangerous: true,
    source: "builtin",
    run: async (args, tctx) => {
      const done = await runtime.agent.compact(
        tctx.sessionId,
        tctx.signal ?? AbortSignal.timeout(180_000),
        undefined,
        typeof args.preserve === "string" ? args.preserve : "",
      );
      return done
        ? "Contexte compacté : les anciens échanges sont remplacés par un résumé."
        : "Conversation trop courte pour être compactée.";
    },
  });
  // core.ts:379 (AnnotationService vit dans plugin-memory) et 574-578 (hub dans plugin-skills).
  runtime.annotations = ctx.memory.annotations;
  runtime.hub = ctx.skillsHub;
  // core.ts:565-573
  runtime.curator = new CuratorService({
    db,
    skills: ctx.skills,
    settings,
    notifications,
    schedulePrompts: () => ctx.scheduler.list().map((sch) => sch.prompt),
    busy: () => runtime.anyRunning(),
  });
  for (const t of skillTools(ctx.skills, runtime.curator)) tools.register(t);
  // core.ts:579
  for (const t of cronTools(ctx.scheduler, (id) => runtime.gatewayChatOf(id))) tools.register(t);
  // core.ts:597-603
  for (const t of presentTools({
    events,
    originOf: (id) => runtime.gatewayChatOf(id),
    sendFile: (target, fileName, data, caption) => runtime.deliverFile(target, fileName, data, caption),
  }))
    tools.register(t);
  // core.ts:619-621
  for (const t of toolSearchTools(tools, ctx.tools.toolSearch, (id) => runtime.agent.settingsFor(id))) {
    tools.register(t);
  }
  // core.ts:634
  for (const t of sessionTools(runtime.sessions, runtime.messages)) tools.register(t);
  // Cockpit, lot 2 : l'agent relit ses propres actions et leurs preuves (lecture seule).
  tools.register(taskStatusTool(runtime.tasks));
  // Cockpit, lot 3 : chercher et relire les sorties volumineuses gardées hors du contexte.
  for (const t of outputTools(runtime.outputs)) tools.register(t);
  // Cockpit, lot 5 : artefacts (enregistrer, lister) et export SVG d'un diagramme.
  for (const t of artifactTools(runtime.artifacts)) tools.register(t);
  // Cockpit, lot 7 : rendu vidéo HyperFrames, comme tâche (accord, annulation, preuve ffprobe, artefact).
  for (const t of videoTools({ artifacts: runtime.artifacts })) tools.register(t);
  // Cockpit, lot 6 : REA et Ghidra en analyse STATIQUE (la cible n'est jamais exécutée), comme tâches (accord, annulation, preuve, artefact).
  for (const t of staticAnalysisTools({ artifacts: runtime.artifacts })) tools.register(t);
  // Q18 : outils `state_*` (SANK-AI `kernel/session-state.js`, MIT), sur la table `session_state` (v18).
  for (const t of sessionStateTools(runtime.state)) tools.register(t);
  // Q18 : sous-agents non bloquants (SANK-AI `rlm-subagent`, MIT), lecture seule.
  for (const t of rlmTools(runtime.rlm, runtime.subagents)) tools.register(t);
  // Q18 : refine (SANK-AI `refine`, MIT) — mémoire mise à jour sur preuve, journalisée, annulable.
  for (const t of refineTools(new RefineService(runtime.memory, settings))) tools.register(t);
  // core.ts:611-618
  runtime.learning = new LearningService({
    messages: runtime.messages,
    memory: runtime.memory,
    profile: runtime.userProfile,
    settings,
    notifications,
    events,
    complete: (prompt, signal, opts) => runtime.agent.complete(prompt, signal, opts),
    busy: (id) => runtime.isRunning(id),
  });
  // A failed or stopped turn teaches nothing; a review failure is not the user's problem. (core.ts:1616-1617)
  ctx.on("agent:turn-done" as never, ((sessionId: string, _hooks: unknown, turn: TurnOutcome) => {
    if (!turn.aborted && !turn.error) void runtime.learning.afterTurn(sessionId).catch(() => {});
  }) as never);

  // `/status` lit l'état MCP (core.ts:2183) : plugin-mcp s'il est chargé, sinon « aucun ».
  const mcp = (ctx.get("mcp") as { list(): { name: string; state: string }[] } | undefined) ?? { list: () => [] };
  registerAgentCommands(Object.assign(runtime, { mcp }));
  registerSkillCommands(runtime);

  // `init()` (core.ts:656) : un seul processus vivant sert un profil ; RuntimeLockError sinon.
  if (config?.runtimeLock !== false) {
    ctx.effect(() => acquireRuntimeLock(ctx.storage.dataDir, config?.runtimeMode ?? "desktop"), "agent:runtime-lock");
  }

  // Les tâches planifiées passent par l'agent (core.ts:516, `runSchedule`).
  ctx.on("schedule/run", (s) => runtime.runSchedule(s));
  ctx.provide("agent", runtime);
  ctx.effect(() => () => runtime.stopAll(), "agent:turns");

  // SPECS-P5-WEBHOOKS § 2.2 — l'exécutant des tâches `webhook` dues.
  // Le runner prend les tâches une à la fois et délègue à `runtime.runWebhook`.
  // Il démarre avec le noyau et s'arrête à la fermeture.
  const webhookRunner = new WebhookRunner({
    jobs: ctx.jobs,
    onRun: async (job) => {
      const payload = job.payload as { hookId: string; payload: unknown };
      const r = await runtime.runWebhook(payload.hookId, payload.payload);
      // Une réponse `ok: false` est un échec : la tâche doit être rejetée (rejeu borné), pas clôturée « ok ».
      if (!r.ok) throw new Error(r.summary || "runWebhook: échec");
    },
  });
  webhookRunner.start();
  ctx.effect(() => () => webhookRunner.stop(), "agent:webhook-runner");
  // Skill upkeep: an hourly check, cheap when nothing is due (see CuratorService.maybeRun). (core.ts:677-678)
  if (config?.curatorTimer !== false) {
    ctx.effect(() => {
      const timer = setInterval(() => void runtime.curator.maybeRun().catch(() => {}), 3_600_000);
      timer.unref?.();
      return () => clearInterval(timer);
    }, "agent:curator");
  }
}
