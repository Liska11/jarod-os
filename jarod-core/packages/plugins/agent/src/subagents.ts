// Portage de packages/core/src/services/subagents.ts (rév. 2e180305).
export type RunStatus = "running" | "done" | "failed" | "cancelled";

export interface SubAgentRun {
  id: string;
  /** Le début de la tâche : de quoi reconnaître l'exécution, pas de quoi la relire. */
  task: string;
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  chars: number | null;
  error: string | null;
}

/** Au-delà, on refuse : un sous-agent par tâche, pas une avalanche de tâches. */
export const DEFAULT_MAX_CONCURRENT = 3;

/**
 * Les sous-agents, tenus et comptés.
 *
 * Un sous-agent est en lecture seule et isolé — c'est bien la seule chose qui était garantie. Rien
 * ne bornait leur nombre : lancer trois tâches qui en lancent trois chacune fait tourner neuf
 * agents sur une machine qui en croyait trois. Rien ne les journalisait non plus, donc une exécution
 * perdue ne laissait aucune trace, et il n'y avait aucun moyen d'en arrêter une.
 *
 * Ici : une borne, un journal, une annulation. Au-delà de la borne, on **refuse** au lieu de faire
 * la queue — un refus lisible vaut mieux qu'une attente dont personne ne connaît la fin.
 */
export class SubagentsService {
  private readonly runs: SubAgentRun[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private seq = 0;

  constructor(private readonly d: { maxConcurrent?: number; now?: () => number; journalLimit?: number } = {}) {}

  private at(): number {
    return this.d.now?.() ?? Date.now();
  }

  /**
   * Le plafond d'exécutions simultanées. Il était privé : rien ne pouvait dire « 3 sur 3 », donc un
   * écran de diagnostic n'aurait pas pu expliquer POURQUOI un lancement a été refusé. La valeur est
   * exposée, la règle ne change pas.
   */
  limit(): number {
    return this.d.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  running(): number {
    return this.runs.filter((run) => run.status === "running").length;
  }

  /** Le journal, du plus récent au plus ancien. */
  list(): SubAgentRun[] {
    return [...this.runs].reverse();
  }

  get(id: string): SubAgentRun | undefined {
    return this.runs.find((run) => run.id === id);
  }

  /** Arrête une exécution en cours. Rend false si elle était déjà finie — et le dit. */
  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    const run = this.get(id);
    if (!controller || !run || run.status !== "running") return false;
    controller.abort();
    return true;
  }

  /** Jarod-cordis (Q18) : arrête toutes les exécutions en cours (arrêt du kernel). */
  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  /**
   * Exécute une tâche sous la borne et sous le journal. `signal` est celui de l'appelant : son
   * annulation se propage à l'exécution, et l'annulation interne se propage dans l'autre sens.
   */
  async run(
    task: string,
    sessionId: string,
    work: (task: string, signal: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.start(task, sessionId, work, signal).result;
  }

  /**
   * Jarod-cordis (Q18, sous-agents non bloquants) : le corps de `run`, mais l'identifiant est rendu TOUT
   * DE SUITE, avec la promesse du résultat. Même borne (refus levé ici, avant tout lancement), même journal.
   */
  start(
    task: string,
    sessionId: string,
    work: (task: string, signal: AbortSignal) => Promise<string>,
    signal?: AbortSignal,
  ): { id: string; result: Promise<string> } {
    if (this.running() >= this.limit()) {
      throw new Error(
        `SUBAGENT_LIMIT: ${this.limit()} sous-agents tournent déjà. Termine-en un, ou relance plus tard.`,
      );
    }
    this.seq += 1;
    const id = `sa-${this.seq}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    this.controllers.set(id, controller);

    const run: SubAgentRun = {
      id,
      task: task.slice(0, 120),
      sessionId,
      startedAt: this.at(),
      endedAt: null,
      status: "running",
      chars: null,
      error: null,
    };
    this.runs.push(run);
    // Le journal est borné : il informe, il n'archive pas.
    const max = this.d.journalLimit ?? 100;
    if (this.runs.length > max) this.runs.splice(0, this.runs.length - max);

    const result = (async () => {
      try {
        const answer = await work(task, controller.signal);
        run.status = "done";
        run.chars = answer.length;
        return answer;
      } catch (error) {
        // Une annulation n'est pas une panne : les confondre ferait passer un arrêt voulu pour un bug.
        const cancelled = controller.signal.aborted && !signal?.aborted ? true : controller.signal.aborted;
        run.status = cancelled ? "cancelled" : "failed";
        run.error = cancelled ? null : error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        run.endedAt = this.at();
        this.controllers.delete(id);
        signal?.removeEventListener("abort", onAbort);
      }
    })();
    return { id, result };
  }
}
