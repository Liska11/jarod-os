/**
 * L'exécutant des tâches `webhook` : prend les tâches dues UNE à la fois, les exécute,
 * et clôt (complete/fail) selon le résultat.
 *
 * Le runner ne contient AUCUNE logique d'agent : il délègue à un callback `onRun`
 * fourni par le plugin qui a accès à l'agent (plugin-agent). Le runner gère :
 * - La prise de tâche (claim) : une seule exécution à la fois
 * - Le résultat (complete/fail) : avec rejeu si la tentative échoue
 * - La récupération (recover) : les tâches `running` au démarrage repartent
 */
import type { Job, JobsService } from "./jobs.js";

export interface WebhookRunnerDeps {
  jobs: JobsService;
  /** Exécute une tâche webhook. Lève une erreur si l'exécution échoue. */
  onRun: (job: Job) => Promise<void>;
  /** Intervalle entre deux vérifications des tâches dues (défaut 1000 ms). */
  tickMs?: number;
  /**
   * M7 — au-delà de ce délai, l'exécution en cours est abandonnée et la tâche repart en échec (défaut :
   * le délai du service de jobs, `JobsService.stalledAfterMs`).
   */
  runTimeoutMs?: number;
}

export class WebhookRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly d: WebhookRunnerDeps) {}

  /** Démarre la vérification périodique des tâches dues. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.d.tickMs ?? 1000);
    this.timer.unref?.();
  }

  /** Arrête la vérification périodique. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Une passe : prend les tâches `webhook` dues une à la fois et les exécute.
   * Retourne le nombre de tâches exécutées.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let count = 0;
    try {
      const due = this.d.jobs.due().filter((j) => j.kind === "webhook");
      for (const job of due) {
        const claimed = this.d.jobs.claim(job.id);
        if (!claimed) continue;
        try {
          await this.withTimeout(this.d.onRun(claimed), claimed.id);
          this.d.jobs.complete(claimed.id, "ok");
          count++;
        } catch (e) {
          this.d.jobs.fail(claimed.id, (e as Error).message);
        }
      }
    } finally {
      this.running = false;
    }
    return count;
  }

  /**
   * M7 — borne l'attente d'un `onRun`. Sans délai, un `onRun` qui ne rend JAMAIS la main laissait `tick()`
   * en vol, donc `running = true` pour toujours : plus AUCUNE tâche webhook ne passait, même après le délai
   * du corps de requête, et il fallait redémarrer l'application. Le perdant de la course garde un `catch`
   * muet pour ne pas devenir un rejet non géré.
   */
  private async withTimeout(promise: Promise<void>, jobId: string): Promise<void> {
    const ms = this.d.runTimeoutMs ?? this.d.jobs.stalledAfterMs;
    promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`délai dépassé (${Math.round(ms / 1000)} s) — ${jobId}`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
