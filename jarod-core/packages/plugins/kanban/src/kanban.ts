/**
 * Tableaux Kanban de Jarod (Q17, décision utilisateur 2026-09-28 : option A) — tables v17 de `jarod.db`.
 *
 * Sémantique reprise du Kanban d'Hermes (`hermes_cli/kanban_db.py` : `create_task`, `assign_task`,
 * `complete_task`, `block_task`, `unblock_task`, `archive_task`, `promote_task`, `schedule_task`,
 * `specify_triage_task`, `reclaim_task`, `recompute_ready`, `list_boards`, `remove_board`), réduite à ce que
 * Jarod sert :
 * - une carte est AUTONOME (décision de conception Q17) : elle ne référence pas un objectif `goals` — un
 *   objectif est l'itération d'UNE conversation, une carte vit entre les conversations ;
 * - exécution = un tour d'agent, déclenché À LA MAIN (`claim` → tour → `finishRun`), jamais par un minuteur :
 *   la tâche passe `running` pendant le tour, puis `review` (réponse à relire et valider) ou `blocked` (échec) ;
 * - une tâche `running` n'accepte que « reprendre » (`reclaim`, qui rend la conversation à arrêter) : aucune
 *   autre transition ne l'écrase pendant un tour ;
 * - `todo` = en attente d'un parent : dès que tous ses parents sont `done`/`archived`, elle passe `ready`
 *   (`recomputeReady`, après chaque transition qui peut libérer un enfant) ;
 * - retrait d'un tableau = archivage ; suppression définitive seulement d'un tableau DÉJÀ archivé (deux gestes).
 * Horodatages en millisecondes (convention Jarod) ; les formes Hermes (secondes) sont faites par le desktop.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "@jarod/plugin-storage";
import { parseSpecifyReply, SPECIFY_SYSTEM, specifyPrompt } from "./specify.js";

export const TASK_STATUSES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DEFAULT_BOARD = "default";

/** Refus d'une opération du tableau : message montré tel quel à l'utilisateur. */
export class KanbanError extends Error {}

export interface KanbanTask {
  id: string;
  board: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  tenant: string | null;
  workspace_kind: "scratch" | "dir";
  workspace_path: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  skills: string[];
  max_retries: number | null;
  /** Conversation du dernier tour d'agent qui a exécuté la tâche. */
  session_id: string | null;
  current_run_id: number | null;
}

export interface KanbanBoard {
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  is_current: boolean;
  archived: boolean;
  total: number;
  counts: Record<string, number>;
}

export interface KanbanComment {
  id: number;
  task_id: string;
  author: string | null;
  body: string;
  created_at: number;
}

export interface KanbanEvent {
  id: number;
  task_id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: number;
  run_id: number | null;
}

export interface KanbanRun {
  id: number;
  task_id: string;
  profile: string | null;
  session_id: string | null;
  status: string;
  outcome: string | null;
  summary: string | null;
  error: string | null;
  started_at: number;
  ended_at: number | null;
  last_heartbeat_at: number | null;
}

export interface KanbanTaskDetail {
  task: KanbanTask;
  comments: KanbanComment[];
  events: KanbanEvent[];
  parents: string[];
  children: string[];
  runs: KanbanRun[];
  latest_summary: string | null;
}

export interface CreateTaskInput {
  title: string;
  body?: string | null;
  assignee?: string | null;
  priority?: number;
  tenant?: string | null;
  /** Dossier de travail déjà jugé par l'appelant (garde fichiers) ; absent = « scratch » (aucun dossier). */
  workspacePath?: string | null;
  triage?: boolean;
  skills?: string[];
  maxRetries?: number | null;
  parents?: string[];
  createdBy?: string | null;
}

export interface TaskFilters {
  status?: string;
  assignee?: string;
  tenant?: string;
  includeArchived?: boolean;
}

/** Ce qu'un clic « Répartir » ferait : la tâche retenue, et pourquoi les autres tâches prêtes ne le sont pas. */
export interface DispatchPlan {
  task: KanbanTask | null;
  skipped: { task_id: string; reason: string }[];
}

type TaskRow = Omit<KanbanTask, "skills"> & { skills: string | null };

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Taille gardée d'un résultat de tour (le texte complet reste dans la conversation). */
const RESULT_MAX = 20_000;
const SUMMARY_MAX = 400;

export function normalizeSlug(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!SLUG.test(s)) throw new KanbanError(`Nom de tableau invalide : « ${String(raw ?? "")} » (lettres minuscules, chiffres, - et _ ; 64 au plus)`);
  return s;
}

/** `atm10-server` → `Atm10 Server` (`_default_board_display_name` d'Hermes). */
export function boardDisplayName(slug: string): string {
  return (
    slug
      .replace(/_/g, "-")
      .split("-")
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ") || slug
  );
}

/** Assigné canonique : vide ou « none » = personne. */
export function canonicalAssignee(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s === "" || s.toLowerCase() === "none" ? null : s;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export class KanbanService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // ---- tableaux --------------------------------------------------------------------------------------------

  private defaultReady = false;

  /**
   * Le tableau `default` existe toujours (comme chez Hermes) ; créé au premier usage, jamais par la migration.
   * Une seule écriture par service (il ne peut être ni retiré ni supprimé) : les lectures de l'écran restent des lectures.
   */
  private ensureDefault(): void {
    if (this.defaultReady) return;
    this.db.run("INSERT OR IGNORE INTO kanban_boards (slug, name, created_at) VALUES (?, ?, ?)", DEFAULT_BOARD, boardDisplayName(DEFAULT_BOARD), this.now());
    this.defaultReady = true;
  }

  private board(slug: string): { slug: string; archived: number } | undefined {
    return this.db.get("SELECT slug, archived FROM kanban_boards WHERE slug = ?", slug);
  }

  currentBoard(): string {
    this.ensureDefault();
    return this.db.get<{ slug: string }>("SELECT slug FROM kanban_boards WHERE is_current = 1 AND archived = 0")?.slug ?? DEFAULT_BOARD;
  }

  listBoards(includeArchived = false): KanbanBoard[] {
    const current = this.currentBoard();
    const rows = this.db.all<{ slug: string; name: string; description: string | null; icon: string | null; color: string | null; archived: number }>(
      `SELECT slug, name, description, icon, color, archived FROM kanban_boards ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY slug = ? DESC, slug`,
      DEFAULT_BOARD,
    );
    const counts = new Map<string, Record<string, number>>();
    for (const c of this.db.all<{ board: string; status: string; n: number }>("SELECT board, status, COUNT(*) AS n FROM kanban_tasks WHERE status != 'archived' GROUP BY board, status")) {
      const m = counts.get(c.board) ?? {};
      m[c.status] = c.n;
      counts.set(c.board, m);
    }
    return rows.map((r) => {
      const byStatus = counts.get(r.slug) ?? {};
      return {
        slug: r.slug,
        name: r.name,
        description: r.description,
        icon: r.icon,
        color: r.color,
        is_current: r.slug === current,
        archived: r.archived === 1,
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        counts: byStatus,
      };
    });
  }

  switchBoard(raw: unknown): void {
    const slug = normalizeSlug(raw);
    this.ensureDefault();
    const b = this.board(slug);
    if (!b) throw new KanbanError(`Tableau inconnu : « ${slug} »`);
    if (b.archived) throw new KanbanError(`Tableau archivé : « ${slug} »`);
    this.db.tx(() => {
      this.db.run("UPDATE kanban_boards SET is_current = 0 WHERE is_current = 1");
      this.db.run("UPDATE kanban_boards SET is_current = 1 WHERE slug = ?", slug);
    });
  }

  /** Création « mkdir -p » (Hermes) : un tableau existant est gardé tel quel ; un tableau archivé du même nom est refusé. */
  createBoard(raw: unknown, name?: string | null, switchAfter = false): void {
    const slug = normalizeSlug(raw);
    this.ensureDefault();
    const b = this.board(slug);
    if (b?.archived) throw new KanbanError(`Un tableau archivé porte déjà ce nom : « ${slug} »`);
    if (!b) this.db.run("INSERT INTO kanban_boards (slug, name, created_at) VALUES (?, ?, ?)", slug, name?.trim() || boardDisplayName(slug), this.now());
    if (switchAfter) this.switchBoard(slug);
  }

  /** Retrait = archivage (tâches gardées) ; `hardDelete` = suppression définitive d'un tableau DÉJÀ archivé. */
  removeBoard(raw: unknown, hardDelete = false): void {
    const slug = normalizeSlug(raw);
    if (slug === DEFAULT_BOARD) throw new KanbanError("Le tableau « default » ne peut pas être retiré");
    const b = this.board(slug);
    if (!b) throw new KanbanError(`Tableau inconnu : « ${slug} »`);
    const running = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM kanban_tasks WHERE board = ? AND status = 'running'", slug)!.n;
    if (running) throw new KanbanError(`Tableau « ${slug} » : ${running} tâche(s) en cours d'exécution — reprenez-les d'abord`);
    if (!hardDelete) {
      this.db.run("UPDATE kanban_boards SET archived = 1, is_current = 0 WHERE slug = ?", slug);
      return;
    }
    if (!b.archived) throw new KanbanError(`Tableau « ${slug} » : archivez-le avant de le supprimer définitivement`);
    this.db.run("DELETE FROM kanban_boards WHERE slug = ?", slug);
  }

  // ---- lecture des tâches ----------------------------------------------------------------------------------

  private row(id: string): TaskRow | undefined {
    return this.db.get<TaskRow>("SELECT * FROM kanban_tasks WHERE id = ?", id);
  }

  private require(id: unknown): TaskRow {
    const r = typeof id === "string" && id ? this.row(id) : undefined;
    if (!r) throw new KanbanError(`Tâche inconnue : ${String(id ?? "")}`);
    return r;
  }

  private view(r: TaskRow): KanbanTask {
    let skills: string[] = [];
    try {
      const v = r.skills ? (JSON.parse(r.skills) as unknown) : [];
      if (Array.isArray(v)) skills = v.map(String);
    } catch {
      skills = [];
    }
    return { ...r, skills };
  }

  getTaskRow(id: string): KanbanTask | null {
    const r = this.row(id);
    return r ? this.view(r) : null;
  }

  /** Tâches du tableau courant : priorité décroissante puis ancienneté (ordre d'Hermes), puis ordre de création. */
  listTasks(f: TaskFilters = {}): KanbanTask[] {
    const where = ["board = ?"];
    const params: (string | number)[] = [this.currentBoard()];
    if (f.status) {
      where.push("status = ?");
      params.push(f.status);
    } else if (!f.includeArchived) where.push("status != 'archived'");
    if (f.assignee) {
      where.push("assignee = ?");
      params.push(f.assignee);
    }
    if (f.tenant) {
      where.push("tenant = ?");
      params.push(f.tenant);
    }
    return this.db.all<TaskRow>(`SELECT * FROM kanban_tasks WHERE ${where.join(" AND ")} ORDER BY priority DESC, created_at ASC, rowid`, ...params).map((r) => this.view(r));
  }

  getTask(id: unknown): KanbanTaskDetail {
    const task = this.view(this.require(id));
    const runs = this.db.all<KanbanRun>("SELECT * FROM kanban_runs WHERE task_id = ? ORDER BY id", task.id);
    return {
      task,
      comments: this.db.all<KanbanComment>("SELECT * FROM kanban_comments WHERE task_id = ? ORDER BY created_at, id", task.id),
      events: this.db
        .all<Omit<KanbanEvent, "payload"> & { payload: string | null }>("SELECT * FROM kanban_events WHERE task_id = ? ORDER BY id", task.id)
        .map((e) => ({ ...e, payload: e.payload ? (JSON.parse(e.payload) as Record<string, unknown>) : null })),
      parents: this.db.all<{ id: string }>("SELECT parent_id AS id FROM kanban_task_links WHERE child_id = ? ORDER BY parent_id", task.id).map((r) => r.id),
      children: this.db.all<{ id: string }>("SELECT child_id AS id FROM kanban_task_links WHERE parent_id = ? ORDER BY child_id", task.id).map((r) => r.id),
      runs,
      latest_summary: [...runs].reverse().find((r) => r.summary)?.summary ?? null,
    };
  }

  // ---- écritures -------------------------------------------------------------------------------------------

  private event(taskId: string, kind: string, payload: Record<string, unknown> | null = null, runId: number | null = null): void {
    this.db.run("INSERT INTO kanban_events (task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)", taskId, runId, kind, payload ? JSON.stringify(payload) : null, this.now());
  }

  private openParents(id: string): string[] {
    return this.db
      .all<{ id: string }>("SELECT p.id FROM kanban_task_links l JOIN kanban_tasks p ON p.id = l.parent_id WHERE l.child_id = ? AND p.status NOT IN ('done', 'archived') ORDER BY p.id", id)
      .map((r) => r.id);
  }

  private setStatus(id: string, from: readonly TaskStatus[], to: TaskStatus, extra = "", ...params: (string | number | null)[]): void {
    const placeholders = from.map(() => "?").join(", ");
    const r = this.db.run(`UPDATE kanban_tasks SET status = ?${extra} WHERE id = ? AND status IN (${placeholders})`, to, ...params, id, ...from);
    if (r.changes !== 1) throw new KanbanError(`Tâche ${id} : état changé pendant l'opération`);
  }

  private refuseRunning(t: TaskRow, verb: string): void {
    if (t.status === "running") throw new KanbanError(`Tâche ${t.id} en cours d'exécution : impossible de ${verb} — utilisez « Reprendre » d'abord`);
  }

  private refuseUnless(t: TaskRow, allowed: readonly TaskStatus[], verb: string): void {
    this.refuseRunning(t, verb);
    if (!allowed.includes(t.status)) throw new KanbanError(`Tâche ${t.id} (« ${t.status} ») : ${verb} n'est possible que depuis ${allowed.map((s) => `« ${s} »`).join(", ")}`);
  }

  private newId(): string {
    for (;;) {
      const id = `t_${randomBytes(4).toString("hex")}`;
      if (!this.row(id)) return id;
    }
  }

  createTask(input: CreateTaskInput): string {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new KanbanError("Le titre est obligatoire");
    const board = this.currentBoard();
    const parents = [...new Set(input.parents ?? [])];
    for (const p of parents) {
      const pr = this.row(p);
      if (!pr) throw new KanbanError(`Tâche parente inconnue : ${p}`);
      if (pr.board !== board) throw new KanbanError(`Tâche parente ${p} : d'un autre tableau (« ${pr.board} »)`);
    }
    const skills = [...new Set((input.skills ?? []).map((s) => String(s).trim()).filter(Boolean))];
    const priority = Number.isFinite(input.priority) ? Math.trunc(input.priority!) : 0;
    const maxRetries = input.maxRetries !== undefined && input.maxRetries !== null && Number.isFinite(input.maxRetries) ? Math.max(0, Math.trunc(input.maxRetries)) : null;
    const assignee = canonicalAssignee(input.assignee);
    const workspacePath = input.workspacePath ?? null;
    const id = this.newId();
    this.db.tx(() => {
      const open = parents.filter((p) => !["done", "archived"].includes(this.row(p)!.status));
      const status: TaskStatus = input.triage ? "triage" : open.length ? "todo" : "ready";
      this.db.run(
        `INSERT INTO kanban_tasks (id, board, title, body, assignee, status, priority, tenant, workspace_kind, workspace_path, created_by, created_at, skills, max_retries)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        board,
        title,
        input.body?.trim() || null,
        assignee,
        status,
        priority,
        input.tenant?.trim() || null,
        workspacePath ? "dir" : "scratch",
        workspacePath,
        input.createdBy ?? null,
        this.now(),
        skills.length ? JSON.stringify(skills) : null,
        maxRetries,
      );
      for (const p of parents) this.db.run("INSERT INTO kanban_task_links (parent_id, child_id) VALUES (?, ?)", p, id);
      this.event(id, "created", { assignee, status, parents, tenant: input.tenant ?? null, workspace_kind: workspacePath ? "dir" : "scratch", workspace_path: workspacePath, skills: skills.length ? skills : null });
      if (status === "todo") this.event(id, "dependency_wait", { reason: "parent_not_done", parent: open[0] });
    });
    return id;
  }

  assign(id: unknown, raw: unknown): void {
    const t = this.require(id);
    this.refuseRunning(t, "la réassigner");
    const assignee = canonicalAssignee(raw);
    this.db.tx(() => {
      this.db.run("UPDATE kanban_tasks SET assignee = ? WHERE id = ?", assignee, t.id);
      this.event(t.id, "assigned", { assignee, from: t.assignee });
    });
  }

  /** `ready`/`blocked`/`review` → `done` (parents terminés) ; libère les enfants. */
  complete(id: unknown, result?: string | null): void {
    const t = this.require(id);
    this.refuseUnless(t, ["ready", "blocked", "review"], "la terminer");
    const open = this.openParents(t.id);
    if (open.length) throw new KanbanError(`Tâche ${t.id} : parents non terminés (${open.join(", ")})`);
    const text = result?.trim() ? clip(result.trim(), RESULT_MAX) : null;
    this.db.tx(() => {
      this.setStatus(t.id, [t.status], "done", ", completed_at = ?, result = COALESCE(?, result)", this.now(), text);
      this.event(t.id, "completed", { from: t.status, result: text ? clip(text, SUMMARY_MAX) : null });
    });
    this.recomputeReady();
  }

  block(id: unknown, reason?: string | null): void {
    const t = this.require(id);
    this.refuseUnless(t, ["todo", "ready", "scheduled", "review"], "la bloquer");
    this.db.tx(() => {
      this.setStatus(t.id, [t.status], "blocked");
      this.event(t.id, "blocked", { reason: reason?.trim() || null, source_status: t.status });
    });
  }

  /** `blocked`/`scheduled` → `ready` (ou `todo` si un parent reste ouvert). */
  unblock(id: unknown): void {
    const t = this.require(id);
    this.refuseUnless(t, ["blocked", "scheduled"], "la débloquer");
    const to: TaskStatus = this.openParents(t.id).length ? "todo" : "ready";
    this.db.tx(() => {
      this.setStatus(t.id, [t.status], to);
      this.event(t.id, "unblocked", to === "ready" ? null : { status: to });
    });
  }

  archive(id: unknown): void {
    const t = this.require(id);
    this.refuseRunning(t, "l'archiver");
    if (t.status === "archived") throw new KanbanError(`Tâche ${t.id} déjà archivée`);
    this.db.tx(() => {
      this.setStatus(t.id, [t.status], "archived");
      this.event(t.id, "archived", { from: t.status });
    });
    this.recomputeReady();
  }

  /** `todo`/`blocked` → `ready`, refusé tant qu'un parent est ouvert (pas de passage en force, comme Hermes). */
  promote(id: unknown, actor = "utilisateur"): void {
    const t = this.require(id);
    this.refuseUnless(t, ["todo", "blocked"], "la rendre prête");
    const open = this.openParents(t.id);
    if (open.length) throw new KanbanError(`Tâche ${t.id} : parents non terminés (${open.join(", ")}) — terminez-les d'abord`);
    this.db.tx(() => {
      this.setStatus(t.id, [t.status], "ready");
      this.event(t.id, "promoted_manual", { actor });
    });
  }

  schedule(id: unknown, reason?: string | null): void {
    const t = this.require(id);
    this.refuseUnless(t, ["todo", "ready", "blocked"], "la planifier");
    this.db.tx(() => {
      this.setStatus(t.id, [t.status], "scheduled");
      this.event(t.id, "scheduled", { reason: reason?.trim() || null });
    });
  }

  /** `triage` → `todo` avec titre/corps précisés (puis `ready` si aucun parent ouvert). */
  specify(id: unknown, fields: { title?: string | null; body?: string | null }, author?: string | null): string[] {
    const t = this.require(id);
    if (t.status !== "triage") throw new KanbanError(`Tâche ${t.id} (« ${t.status} ») : seule une tâche « triage » se spécifie`);
    const title = fields.title?.trim();
    if (fields.title !== undefined && fields.title !== null && !title) throw new KanbanError("Le titre ne peut pas être vide");
    const changed: string[] = [];
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (title && title !== t.title) {
      sets.push(", title = ?");
      params.push(title);
      changed.push("title");
    }
    if (fields.body !== undefined && fields.body !== null && fields.body !== (t.body ?? "")) {
      sets.push(", body = ?");
      params.push(fields.body);
      changed.push("body");
    }
    this.db.tx(() => {
      this.setStatus(t.id, ["triage"], "todo", sets.join(""), ...params);
      if (changed.length && author?.trim())
        this.db.run("INSERT INTO kanban_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)", t.id, author.trim(), `Spécifiée — ${changed.join(", ")} mis à jour, passée en « todo ».`, this.now());
      this.event(t.id, "specified", changed.length ? { changed_fields: changed } : null);
    });
    this.recomputeReady();
    return changed;
  }

  /** L'appel LLM de « Spécifier » (tâche `triage` seulement) : message système et message de la tâche. */
  specifyRequest(id: unknown): { system: string; prompt: string } {
    const t = this.require(id);
    if (t.status !== "triage") throw new KanbanError(`Tâche ${t.id} (« ${t.status} ») : seule une tâche « triage » se spécifie`);
    return { system: SPECIFY_SYSTEM, prompt: specifyPrompt(t) };
  }

  /** Applique la réponse du LLM (analyse tolérante) ; réponse vide = refus, la tâche reste en triage. */
  applySpecifyReply(id: unknown, raw: string, author?: string | null): string[] {
    const parsed = parseSpecifyReply(raw);
    if (!parsed) throw new KanbanError("Spécification impossible : le modèle n'a rien rendu d'utilisable (la tâche reste en triage)");
    return this.specify(id, parsed, author);
  }

  /** `running` → `ready`/`todo` : l'exécution est close (« reclaimed ») ; rend la conversation du tour à arrêter. */
  reclaim(id: unknown, reason?: string | null): { sessionId: string | null } {
    const t = this.require(id);
    if (t.status !== "running") throw new KanbanError(`Tâche ${t.id} (« ${t.status} ») : rien à reprendre (pas en cours d'exécution)`);
    const to: TaskStatus = this.openParents(t.id).length ? "todo" : "ready";
    const run = t.current_run_id ? this.db.get<{ session_id: string | null }>("SELECT session_id FROM kanban_runs WHERE id = ?", t.current_run_id) : undefined;
    this.db.tx(() => {
      if (t.current_run_id)
        this.db.run(
          "UPDATE kanban_runs SET status = 'reclaimed', outcome = 'reclaimed', ended_at = ?, error = ? WHERE id = ? AND ended_at IS NULL",
          this.now(),
          reason?.trim() ? `reprise manuelle : ${reason.trim()}` : "reprise manuelle",
          t.current_run_id,
        );
      this.setStatus(t.id, ["running"], to, ", current_run_id = NULL");
      this.event(t.id, "reclaimed", { manual: true, reason: reason?.trim() || null, status: to }, t.current_run_id);
    });
    return { sessionId: run?.session_id ?? null };
  }

  comment(id: unknown, body: unknown, author?: string | null): number {
    const t = this.require(id);
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) throw new KanbanError("Commentaire vide");
    return this.db.tx(() => {
      const r = this.db.get<{ id: number }>("INSERT INTO kanban_comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?) RETURNING id", t.id, author ?? null, text, this.now())!;
      this.event(t.id, "commented", { author: author ?? null });
      return r.id;
    });
  }

  /** `todo` dont tous les parents sont terminés → `ready` (`recompute_ready` d'Hermes, sans les blocages). */
  recomputeReady(): number {
    let promoted = 0;
    this.db.tx(() => {
      for (const { id } of this.db.all<{ id: string }>("SELECT id FROM kanban_tasks WHERE status = 'todo' ORDER BY created_at")) {
        if (this.openParents(id).length) continue;
        this.db.run("UPDATE kanban_tasks SET status = 'ready' WHERE id = ? AND status = 'todo'", id);
        this.event(id, "promoted");
        promoted++;
      }
    });
    return promoted;
  }

  // ---- exécution (tour d'agent déclenché à la main) --------------------------------------------------------

  /**
   * La tâche qu'un clic « Répartir » exécuterait : `ready` du tableau courant, ASSIGNÉE au profil servi, la plus
   * prioritaire puis la plus ancienne. Les autres tâches prêtes sont listées avec la raison.
   */
  dispatchPlan(profile: string): DispatchPlan {
    const skipped: DispatchPlan["skipped"] = [];
    let task: KanbanTask | null = null;
    for (const t of this.listTasks({ status: "ready" })) {
      if (!t.assignee) skipped.push({ task_id: t.id, reason: "non assignée" });
      else if (t.assignee !== profile) skipped.push({ task_id: t.id, reason: `assignée au profil « ${t.assignee} », non servi (profil servi : « ${profile} »)` });
      else if (this.openParents(t.id).length) skipped.push({ task_id: t.id, reason: "parents non terminés" });
      else if (task) skipped.push({ task_id: t.id, reason: "une tâche par répartition (déclenchée à la main)" });
      else task = t;
    }
    return { task, skipped };
  }

  /** `ready` → `running` : ouvre une exécution liée à la conversation du tour. Rend son id. */
  claim(id: string, profile: string, sessionId: string): number {
    const t = this.require(id);
    if (t.status !== "ready") throw new KanbanError(`Tâche ${t.id} (« ${t.status} ») : seule une tâche prête s'exécute`);
    const now = this.now();
    return this.db.tx(() => {
      const run = this.db.get<{ id: number }>(
        "INSERT INTO kanban_runs (task_id, profile, session_id, status, started_at, last_heartbeat_at) VALUES (?, ?, ?, 'running', ?, ?) RETURNING id",
        t.id,
        profile,
        sessionId,
        now,
        now,
      )!.id;
      this.setStatus(t.id, ["ready"], "running", ", started_at = COALESCE(started_at, ?), current_run_id = ?, session_id = ?", now, run, sessionId);
      this.event(t.id, "claimed", { profile, session_id: sessionId }, run);
      return run;
    });
  }

  /**
   * Fin du tour : réponse → `review` (à relire, puis « Terminer ») ; erreur ou réponse vide → `blocked`. Sans
   * effet si l'exécution n'est plus la courante (reprise entre-temps). Rend le nouvel état, ou null.
   */
  finishRun(runId: number, r: { text: string; error?: string }): TaskStatus | null {
    const task = this.db.get<TaskRow>("SELECT * FROM kanban_tasks WHERE current_run_id = ? AND status = 'running'", runId);
    if (!task) return null;
    const text = r.text.trim();
    const error = r.error ?? (text ? undefined : "tour terminé sans réponse");
    const now = this.now();
    return this.db.tx(() => {
      if (error) {
        this.db.run("UPDATE kanban_runs SET status = 'blocked', outcome = 'blocked', error = ?, ended_at = ?, last_heartbeat_at = ? WHERE id = ?", clip(error, RESULT_MAX), now, now, runId);
        this.setStatus(task.id, ["running"], "blocked", ", current_run_id = NULL");
        this.event(task.id, "blocked", { reason: clip(error, SUMMARY_MAX), kind: "turn_failed", source_status: "running" }, runId);
        return "blocked" as const;
      }
      this.db.run("UPDATE kanban_runs SET status = 'done', outcome = 'completed', summary = ?, ended_at = ?, last_heartbeat_at = ? WHERE id = ?", clip(text, SUMMARY_MAX), now, now, runId);
      this.setStatus(task.id, ["running"], "review", ", current_run_id = NULL, result = ?", clip(text, RESULT_MAX));
      this.event(task.id, "review_requested", { session_id: task.session_id }, runId);
      return "review" as const;
    });
  }

  /**
   * Au démarrage : une tâche restée `running` a perdu son tour (Jarod arrêté pendant l'exécution) → exécution
   * close « crashed », tâche rendue `ready` (rien ne la relance : la répartition est manuelle).
   */
  recoverInterrupted(): number {
    const stale = this.db.all<TaskRow>("SELECT * FROM kanban_tasks WHERE status = 'running'");
    if (!stale.length) return 0;
    const now = this.now();
    this.db.tx(() => {
      for (const t of stale) {
        if (t.current_run_id)
          this.db.run("UPDATE kanban_runs SET status = 'crashed', outcome = 'crashed', error = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL", "interrompue par l'arrêt de Jarod", now, t.current_run_id);
        this.db.run("UPDATE kanban_tasks SET status = 'ready', current_run_id = NULL WHERE id = ?", t.id);
        this.event(t.id, "crashed", { reason: "interrompue par l'arrêt de Jarod", status: "ready" }, t.current_run_id);
      }
    });
    return stale.length;
  }

  /** Le message du tour d'agent : la carte, ses commentaires et les résultats de ses parents. */
  workerPrompt(id: string): string {
    const d = this.getTask(id);
    const t = d.task;
    const lines = [`Tâche du tableau Kanban « ${t.board} » (${t.id}) : ${t.title}`];
    if (t.body) lines.push("", t.body);
    if (t.skills.length) lines.push("", `Skills demandés : ${t.skills.join(", ")}`);
    lines.push("", t.workspace_path ? `Dossier de travail : ${t.workspace_path}` : "Aucun dossier de travail (tâche sans fichiers).");
    const parents = d.parents.map((p) => this.row(p)).filter((p): p is TaskRow => !!p && !!p.result);
    if (parents.length) lines.push("", "Résultats des tâches parentes :", ...parents.map((p) => `- ${p.id} « ${p.title} » : ${clip(p.result!, 2_000)}`));
    if (d.comments.length) lines.push("", "Commentaires :", ...d.comments.slice(-20).map((c) => `- ${c.author ?? "?"} : ${clip(c.body, 2_000)}`));
    const prior = d.runs.filter((r) => r.error);
    if (prior.length) lines.push("", "Essais précédents :", ...prior.slice(-5).map((r) => `- ${r.outcome ?? r.status} : ${clip(r.error!, 500)}`));
    lines.push("", "Exécute cette tâche. Termine par un compte rendu : ce qui a été fait, ce qui reste, et les fichiers touchés.");
    return lines.join("\n");
  }
}
