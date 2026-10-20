/**
 * Cockpit, lot 2 : le registre des tâches. Chaque action qui passe par la porte unique (`executeGuardedTool`) avec un effet, une
 * lecture auditée ou un accord à demander y devient une TÂCHE : sa cible, l'action résolue présentée à l'accord, ses étapes, son statut,
 * sa preuve, et un moyen de l'annuler. Le journal d'audit (contrat c7) reste tel quel ; ceci le complète sans le dupliquer : l'audit dit
 * qui a décidé, la tâche dit ce qui s'est passé et ce qui a été constaté.
 *
 * En mémoire (borné) pour les tâches vivantes ; les tâches finies passent au magasin fourni (le flux d'événements `tasks` du runtime).
 */
import { randomUUID } from "node:crypto";
import type { Proof } from "@jarod/plugin-tools";

export type TaskStatus = "awaiting-approval" | "running" | "verifying" | "done" | "failed" | "refused" | "cancelled";
export type TaskStep = "demandée" | "accord demandé" | "accordée" | "refusée" | "exécution" | "vérification" | "terminée" | "échec" | "annulée";

export interface TaskRecord {
  id: string;
  sessionId: string;
  tool: string;
  /** La cible résolue de l'appel (`ToolDef.targetOf`), si l'outil la dit. */
  target?: string;
  /** L'action telle qu'elle a été (ou aurait été) présentée à l'accord. */
  summary: string;
  status: TaskStatus;
  steps: { at: number; step: TaskStep; detail?: string }[];
  proof?: Proof;
  error?: string;
  createdAt: number;
  endedAt?: number;
}

export interface TaskStore {
  save(task: TaskRecord): void;
  /** Les tâches finies déjà connues, de la plus ancienne à la plus récente. */
  load(): TaskRecord[];
}

const FINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed", "refused", "cancelled"]);
const FINAL_STEP: Record<"done" | "failed" | "refused" | "cancelled", TaskStep> = { done: "terminée", failed: "échec", refused: "refusée", cancelled: "annulée" };

export class TaskLedger {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly max: number;
  private readonly now: () => number;
  private readonly store?: TaskStore;

  constructor(o: { store?: TaskStore; max?: number; now?: () => number } = {}) {
    this.max = o.max ?? 200;
    this.now = o.now ?? Date.now;
    if (o.store) this.store = o.store;
    try {
      for (const t of o.store?.load() ?? []) this.keep(t);
    } catch {
      // un historique illisible ne doit jamais empêcher l'agent de démarrer
    }
  }

  /** Ouvre une tâche ; `signal` (s'il est donné) l'annule aussi : la tâche suit l'arrêt du tour de l'agent. */
  begin(o: { sessionId: string; tool: string; summary: string; target?: string }, signal?: AbortSignal): { id: string; signal: AbortSignal } {
    const ctrl = new AbortController();
    const at = this.now();
    const task: TaskRecord = {
      id: randomUUID(),
      sessionId: o.sessionId,
      tool: o.tool,
      ...(o.target !== undefined ? { target: o.target } : {}),
      summary: o.summary,
      status: "running",
      steps: [{ at, step: "demandée" }],
      createdAt: at,
    };
    this.keep(task);
    this.controllers.set(task.id, ctrl);
    return { id: task.id, signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal };
  }

  step(id: string, step: TaskStep, detail?: string, status?: TaskStatus): void {
    const t = this.tasks.get(id);
    if (!t || FINAL.has(t.status)) return;
    t.steps.push({ at: this.now(), step, ...(detail ? { detail } : {}) });
    if (status) t.status = status;
  }

  finish(id: string, status: "done" | "failed" | "refused" | "cancelled", extra: { proof?: Proof; error?: string } = {}): void {
    const t = this.tasks.get(id);
    if (!t || FINAL.has(t.status)) return;
    const at = this.now();
    t.steps.push({ at, step: FINAL_STEP[status] });
    t.status = status;
    t.endedAt = at;
    if (extra.proof) t.proof = extra.proof;
    if (extra.error) t.error = extra.error;
    this.controllers.delete(id);
    try {
      this.store?.save(structuredClone(t));
    } catch {
      // la trace est utile, jamais bloquante
    }
  }

  /** Annule une tâche vivante (accord en attente ou exécution) : son signal est coupé. Faux si elle est finie ou inconnue. */
  cancel(id: string): boolean {
    const t = this.tasks.get(id);
    const ctrl = this.controllers.get(id);
    if (!t || !ctrl || FINAL.has(t.status)) return false;
    ctrl.abort(new Error("tâche annulée"));
    this.finish(id, "cancelled");
    return true;
  }

  get(id: string): TaskRecord | undefined {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : undefined;
  }

  /** Les tâches, la plus récente d'abord. */
  list(limit = this.max): TaskRecord[] {
    return [...this.tasks.values()].reverse().slice(0, limit).map((t) => structuredClone(t));
  }

  private keep(t: TaskRecord): void {
    this.tasks.delete(t.id);
    this.tasks.set(t.id, t);
    while (this.tasks.size > this.max) {
      // On évince la plus ancienne tâche FINIE ; une tâche vivante n'est jamais oubliée.
      const oldest = [...this.tasks.values()].find((x) => FINAL.has(x.status));
      if (!oldest) break;
      this.tasks.delete(oldest.id);
    }
  }
}

const STATUS_FR: Record<TaskStatus, string> = {
  "awaiting-approval": "accord attendu",
  running: "en cours",
  verifying: "vérification",
  done: "terminée",
  failed: "échec",
  refused: "refusée",
  cancelled: "annulée",
};
const PROOF_FR: Record<Proof["status"], string> = { verified: "constaté", failed: "NON constaté", unverifiable: "vérification impossible" };

/**
 * L'outil `task_status` de l'agent : ses propres actions de CETTE conversation — statut et preuve — pour présenter un résultat avec ce
 * qui a été constaté plutôt qu'avec ce qui a été dit. Lecture seule : l'annulation reste à l'utilisateur (écran Tâches).
 */
export function taskStatusTool(ledger: TaskLedger) {
  return {
    name: "task_status",
    description: "Tes dernières actions dans cette conversation : action résolue, statut et preuve constatée après coup (ou pourquoi elle est impossible).",
    parameters: { type: "object", properties: { limit: { type: "integer", description: "Nombre d'actions (10 par défaut, 50 au plus)." } } },
    source: "builtin" as const,
    async run(args: Record<string, unknown>, ctx: { sessionId: string }) {
      const n = typeof args.limit === "number" && Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 10;
      const mine = ledger.list().filter((t) => t.sessionId === ctx.sessionId).slice(0, n);
      if (!mine.length) return "Aucune action enregistrée dans cette conversation.";
      return mine
        .map((t) => {
          const proof = t.proof ? ` — ${PROOF_FR[t.proof.status]} : ${t.proof.evidence}` : "";
          return `${STATUS_FR[t.status]} · ${t.summary}${t.target ? ` [${t.target}]` : ""}${proof}${t.error ? ` — ${t.error}` : ""}`;
        })
        .join("\n");
    },
  };
}
