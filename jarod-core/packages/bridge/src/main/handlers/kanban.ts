/**
 * Kanban aux formes hermesAPI (Q17, décision utilisateur 2026-09-28 : option A), sur plugin-kanban (`jarod.db`
 * v17). Sources des formes : SANK-UI `src/main/kanban.ts` (`KanbanTask`, `KanbanBoard`, `KanbanRun`,
 * `KanbanComment`, `KanbanEvent`, `KanbanTaskDetail`, `KanbanResult` : `{ success, data?, error? }`, jamais une
 * exception), `src/preload/index.ts:1489-1570` (arguments). Horodatages Hermes en secondes.
 *
 * - Espace de travail d'une tâche (`workspace`) : « scratch » = aucun dossier ; « dir:<chemin> » = dossier jugé
 *   par la garde Q12 (`bindable` : choisi dans la boîte native pendant ce lancement, ou sous un dossier de
 *   travail), à la création PUIS à chaque exécution ; « worktree » (git d'Hermes) = refusé.
 * - « Répartir » (`kanban-dispatch-once`) = UN tour d'agent, déclenché À LA MAIN : la tâche prête la plus
 *   prioritaire, assignée au profil servi, s'exécute dans une conversation dédiée (dossier de la tâche lié,
 *   permissions refusées par défaut : `backgroundHooks`, comme une tâche planifiée) ; l'appel rend la main
 *   aussitôt, la tâche est `running` jusqu'à la fin du tour, puis `review` (à relire) ou `blocked` (échec).
 *   Aucun minuteur de répartition. `dryRun` = ce qui serait exécuté, sans rien faire.
 * - « Spécifier » = un appel LLM ponctuel sans outils (`agent.complete`, prompt porté d'Hermes).
 * - `kanban-list-claw3d-hq-tasks` : tableau Claw3D en mode tunnel SSH, hors périmètre (Q8) → échec avec sa raison.
 */
import { GateDenied, type FileGate } from "../file-gate.js";
import { assertProfile, type HandlerContext, toHermesTime } from "./context.js";

interface PortTask {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority: number;
  tenant: string | null;
  workspace_kind: string;
  workspace_path: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  skills: string[];
  max_retries: number | null;
}

interface PortRun {
  id: number;
  task_id: string;
  profile: string | null;
  status: string;
  outcome: string | null;
  summary: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  last_heartbeat_at: number | null;
}

/** plugin-kanban vu par un port STRUCTUREL (le desktop ne dépend pas du paquet). */
export interface KanbanPort {
  currentBoard(): string;
  listBoards(includeArchived?: boolean): {
    slug: string;
    name: string;
    description: string | null;
    icon: string | null;
    color: string | null;
    is_current: boolean;
    archived: boolean;
    total: number;
    counts: Record<string, number>;
  }[];
  switchBoard(slug: unknown): void;
  createBoard(slug: unknown, name?: string | null, switchAfter?: boolean): void;
  removeBoard(slug: unknown, hardDelete?: boolean): void;
  listTasks(f?: { status?: string; assignee?: string; tenant?: string; includeArchived?: boolean }): PortTask[];
  getTask(id: unknown): {
    task: PortTask;
    comments: { id: number; task_id: string; author: string | null; body: string; created_at: number }[];
    events: { id: number; task_id: string; kind: string; payload: Record<string, unknown> | null; created_at: number; run_id: number | null }[];
    parents: string[];
    children: string[];
    runs: PortRun[];
    latest_summary: string | null;
  };
  createTask(input: {
    title: string;
    body?: string | null;
    assignee?: string | null;
    priority?: number;
    tenant?: string | null;
    workspacePath?: string | null;
    triage?: boolean;
    skills?: string[];
    maxRetries?: number | null;
    createdBy?: string | null;
  }): string;
  assign(id: unknown, assignee: unknown): void;
  complete(id: unknown, result?: string | null): void;
  block(id: unknown, reason?: string | null): void;
  unblock(id: unknown): void;
  archive(id: unknown): void;
  promote(id: unknown, actor?: string): void;
  schedule(id: unknown, reason?: string | null): void;
  specifyRequest(id: unknown): { system: string; prompt: string };
  applySpecifyReply(id: unknown, raw: string, author?: string | null): string[];
  reclaim(id: unknown, reason?: string | null): { sessionId: string | null };
  comment(id: unknown, body: unknown, author?: string | null): number;
  dispatchPlan(profile: string): { task: PortTask | null; skipped: { task_id: string; reason: string }[] };
  claim(id: string, profile: string, sessionId: string): number;
  finishRun(runId: number, r: { text: string; error?: string }): string | null;
  workerPrompt(id: string): string;
}

type KanbanResult = { success: boolean; data?: unknown; error?: string };

export const CLAW3D_HQ_UNAVAILABLE =
  "[oneai] tableau Claw3D HQ non disponible : Claw3D (mode tunnel SSH) est hors du périmètre de Jarod (BESOINS Q8)";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function hermesTask(t: PortTask) {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    assignee: t.assignee,
    status: t.status,
    priority: t.priority,
    tenant: t.tenant,
    workspace_kind: t.workspace_kind,
    workspace_path: t.workspace_path,
    created_by: t.created_by,
    created_at: toHermesTime(t.created_at),
    started_at: toHermesTime(t.started_at),
    completed_at: toHermesTime(t.completed_at),
    result: t.result,
    skills: t.skills,
    max_retries: t.max_retries,
  };
}

export function createKanbanHandlers(ctx: HandlerContext, gate: FileGate) {
  const k = () => ctx.kernel();
  /** Chaque canal rend la forme `KanbanResult` de SANK-UI : un refus est `{ success: false, error }`, jamais une exception. */
  const call = async (profile: unknown, fn: (kanban: KanbanPort) => unknown | Promise<unknown>): Promise<KanbanResult> => {
    try {
      assertProfile(ctx, profile);
      const kanban = k().kanban;
      if (!kanban) return { success: false, error: "[oneai] plugin-kanban désactivé" };
      const data = await fn(kanban);
      return data === undefined ? { success: true } : { success: true, data };
    } catch (e) {
      return { success: false, error: e instanceof GateDenied ? `Dossier refusé par la garde fichiers : ${e.reason}` : (e as Error).message };
    }
  };

  /** « scratch » | « dir:<chemin> » → dossier réel autorisé (garde Q12) ou null ; « worktree » et le reste : refus. */
  const workspaceOf = (channel: string, raw: unknown): string | null => {
    if (raw === undefined || raw === null || raw === "" || raw === "scratch") return null;
    if (typeof raw === "string" && raw.startsWith("dir:")) return gate.bindable(channel, raw.slice(4));
    if (raw === "worktree") throw new Error("Espace « worktree » non disponible dans Jarod : choisissez « scratch » ou un dossier");
    throw new Error(`Espace de travail non reconnu : « ${String(raw)} »`);
  };

  return {
    "kanban-list-boards": (includeArchived?: unknown, profile?: unknown) => call(profile, (kb) => kb.listBoards(includeArchived === true)),
    "kanban-current-board": (profile?: unknown) => call(profile, (kb) => kb.currentBoard()),
    "kanban-switch-board": (slug: unknown, profile?: unknown) => call(profile, (kb) => kb.switchBoard(slug)),
    "kanban-create-board": (slug: unknown, name?: unknown, switchAfter?: unknown, profile?: unknown) =>
      call(profile, (kb) => kb.createBoard(slug, str(name) ?? null, switchAfter === true)),
    "kanban-remove-board": (slug: unknown, hardDelete?: unknown, profile?: unknown) => call(profile, (kb) => kb.removeBoard(slug, hardDelete === true)),
    "kanban-list-tasks": (filters?: unknown) => {
      const f = (filters && typeof filters === "object" ? filters : {}) as Record<string, unknown>;
      return call(f.profile, (kb) =>
        kb
          .listTasks({
            ...(str(f.status) ? { status: str(f.status)! } : {}),
            ...(str(f.assignee) ? { assignee: str(f.assignee)! } : {}),
            ...(str(f.tenant) ? { tenant: str(f.tenant)! } : {}),
            includeArchived: f.includeArchived === true,
          })
          .map(hermesTask),
      );
    },
    "kanban-get-task": (taskId: unknown, profile?: unknown) =>
      call(profile, (kb) => {
        const d = kb.getTask(taskId);
        return {
          task: hermesTask(d.task),
          comments: d.comments.map((c) => ({ ...c, created_at: toHermesTime(c.created_at) })),
          events: d.events.map((e) => ({ ...e, created_at: toHermesTime(e.created_at) })),
          parents: d.parents,
          children: d.children,
          runs: d.runs.map((r) => ({
            id: r.id,
            task_id: r.task_id,
            profile: r.profile,
            status: r.status,
            outcome: r.outcome,
            summary: r.summary,
            error: r.error,
            started_at: toHermesTime(r.started_at),
            ended_at: toHermesTime(r.ended_at),
            last_heartbeat_at: toHermesTime(r.last_heartbeat_at),
          })),
          latest_summary: d.latest_summary,
        };
      }),
    "kanban-create-task": (input: unknown, profile?: unknown) =>
      call(profile, (kb) => {
        const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
        const id = kb.createTask({
          title: typeof i.title === "string" ? i.title : "",
          body: str(i.body) ?? null,
          assignee: str(i.assignee) ?? null,
          ...(typeof i.priority === "number" ? { priority: i.priority } : {}),
          tenant: str(i.tenant) ?? null,
          workspacePath: workspaceOf("kanban-create-task", i.workspace),
          triage: i.triage === true,
          skills: Array.isArray(i.skills) ? i.skills.filter((s): s is string => typeof s === "string") : [],
          maxRetries: typeof i.maxRetries === "number" ? i.maxRetries : null,
          createdBy: k().profile,
        });
        return { id };
      }),
    "kanban-assign-task": (taskId: unknown, assignee: unknown, profile?: unknown) => call(profile, (kb) => kb.assign(taskId, assignee)),
    "kanban-complete-task": (taskId: unknown, result?: unknown, profile?: unknown) => call(profile, (kb) => kb.complete(taskId, str(result) ?? null)),
    "kanban-block-task": (taskId: unknown, reason?: unknown, profile?: unknown) => call(profile, (kb) => kb.block(taskId, str(reason) ?? null)),
    "kanban-unblock-task": (taskId: unknown, profile?: unknown) => call(profile, (kb) => kb.unblock(taskId)),
    "kanban-archive-task": (taskId: unknown, profile?: unknown) => call(profile, (kb) => kb.archive(taskId)),
    "kanban-promote-task": (taskId: unknown, profile?: unknown) => call(profile, (kb) => kb.promote(taskId, k().profile)),
    "kanban-schedule-task": (taskId: unknown, reason?: unknown, profile?: unknown) => call(profile, (kb) => kb.schedule(taskId, str(reason) ?? null)),
    "kanban-specify-task": (taskId: unknown, profile?: unknown) =>
      call(profile, async (kb) => {
        const req = kb.specifyRequest(taskId);
        const raw = await k().agent.agent.complete(req.prompt, AbortSignal.timeout(120_000), { system: req.system, thinking: false });
        kb.applySpecifyReply(taskId, raw, k().profile);
      }),
    "kanban-reclaim-task": (taskId: unknown, reason?: unknown, profile?: unknown) =>
      call(profile, (kb) => {
        const { sessionId } = kb.reclaim(taskId, str(reason) ?? null);
        // Le tour en cours est arrêté : sa fin ne touchera plus la tâche (exécution close « reclaimed »).
        if (sessionId && k().agent.isRunning(sessionId)) k().agent.stop(sessionId);
      }),
    "kanban-comment-task": (taskId: unknown, body: unknown, profile?: unknown) => call(profile, (kb) => void kb.comment(taskId, body, k().profile)),
    "kanban-dispatch-once": (dryRun?: unknown, profile?: unknown) =>
      call(profile, (kb) => {
        const kernel = k();
        const plan = kb.dispatchPlan(kernel.profile);
        if (dryRun === true) return { dry_run: true, would_spawn: plan.task ? [{ task_id: plan.task.id, title: plan.task.title }] : [], skipped: plan.skipped };
        const task = plan.task;
        if (!task) return { spawned: [], skipped: plan.skipped };
        let workspace: string | null = null;
        if (task.workspace_path) {
          try {
            workspace = gate.bindable("kanban-dispatch-once", task.workspace_path);
          } catch (e) {
            if (!(e instanceof GateDenied)) throw e;
            kb.block(task.id, `dossier refusé par la garde fichiers : ${e.reason}`);
            throw new Error(`Tâche ${task.id} non exécutée et passée « bloquée » : dossier refusé par la garde fichiers (${e.reason}) — rechoisissez-le avec « Choisir un dossier » puis débloquez-la`);
          }
        }
        const agent = kernel.agent;
        const session = agent.sessions.create(`\u{1F4CB} ${task.title}`.slice(0, 80));
        agent.updateSessionContext(session.id, { workspace });
        const runId = kb.claim(task.id, kernel.profile, session.id);
        const finish = (r: { text: string; error?: string }) => {
          try {
            kb.finishRun(runId, r);
          } catch {
            // Kernel fermé entre-temps (changement de profil) : la tâche sera rendue « prête » au prochain démarrage.
          }
        };
        void agent
          .runAndWait(session.id, kb.workerPrompt(task.id), agent.backgroundHooks)
          .then(finish, (e: unknown) => finish({ text: "", error: (e as Error).message }));
        return { spawned: [{ task_id: task.id, session_id: session.id, run_id: runId }], skipped: plan.skipped };
      }),
    "kanban-list-claw3d-hq-tasks": async (): Promise<KanbanResult> => ({ success: false, error: CLAW3D_HQ_UNAVAILABLE }),
  };
}
