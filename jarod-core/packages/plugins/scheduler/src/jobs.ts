import { randomUUID } from "node:crypto";
import type { Db } from "@jarod/plugin-storage";

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Job {
  id: string;
  kind: string;
  payload: unknown;
  /** Ce à quoi l'exécution appartient (une règle d'automation, une tâche webhook), en clair et indexé. */
  ref: string | null;
  idempotencyKey: string | null;
  dueAt: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  result: string | null;
  /** L'instant de la PRISE (`claim`), tant que l'exécution est `running` (sinon null). */
  startedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  kind: string;
  payload: string;
  ref: string | null;
  idempotency_key: string | null;
  due_at: number;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: string | null;
  started_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * A durable queue of executions, which the schedules were missing.
 *
 * Three properties, and each one answers a way this machine already lost work:
 *
 * Idempotent — an enqueue carrying a key it has already seen returns the job that exists instead of
 * a second one. A retried call cannot duplicate an execution.
 *
 * Bounded — a failing job is retried with a growing delay up to its own ceiling, then parked as
 * failed with the error kept. It never retries forever, and it never gives up silently.
 *
 * Recovering — a job still marked running at startup is one whose process died mid-flight; it goes
 * back to pending. This is the hole the scheduler had: an execution interrupted by a crash stayed
 * "running" forever and was never considered again.
 */
export class JobsService {
  constructor(
    private readonly d: {
      db: Db;
      now?: () => number;
      /** Le délai avant nouvelle tentative, en millisecondes. Croît, puis plafonne à une heure. */
      backoffMs?: (attempt: number) => number;
      /**
       * M7 — au-delà de ce délai, une exécution encore `running` est considérée BLOQUÉE : un `onRun` qui ne
       * rend jamais la main laissait sinon la ligne `running` pour toujours, donc invisible de `due()`, et
       * `recover()` ne regarde qu'au démarrage — le runner restait figé. Défaut : 15 minutes.
       */
      stalledAfterMs?: number;
    },
  ) {}

  private at(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** Le délai au-delà duquel une exécution `running` est déclarée bloquée. */
  get stalledAfterMs(): number {
    return this.d.stalledAfterMs ?? 15 * 60_000;
  }

  private delay(attempt: number): number {
    if (this.d.backoffMs) return this.d.backoffMs(attempt);
    return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  }

  /**
   * Met une exécution en file. Avec une clé déjà vue, c'est **la même** qui revient : `created` dit
   * laquelle des deux choses vient de se passer, plutôt que de laisser deviner.
   */
  enqueue(input: { kind: string; payload?: unknown; ref?: string; idempotencyKey?: string; dueAt?: number; maxAttempts?: number }): {
    job: Job;
    created: boolean;
  } {
    const existing = input.idempotencyKey ? this.byKey(input.idempotencyKey) : undefined;
    if (existing) return { job: existing, created: false };

    const id = randomUUID();
    const at = this.at();
    try {
      this.d.db.run(
        `INSERT INTO jobs (id, kind, payload, ref, idempotency_key, due_at, status, attempts, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        id,
        input.kind,
        JSON.stringify(input.payload ?? {}),
        input.ref ?? null,
        input.idempotencyKey ?? null,
        input.dueAt ?? at,
        input.maxAttempts ?? 3,
        at,
        at,
      );
    } catch (error) {
      // La clé est unique en base : deux appels simultanés ne peuvent pas créer deux exécutions,
      // même si la lecture ci-dessus les a laissés passer tous les deux.
      const raced = input.idempotencyKey ? this.byKey(input.idempotencyKey) : undefined;
      if (raced) return { job: raced, created: false };
      throw error;
    }
    return { job: this.get(id) as Job, created: true };
  }

  byKey(key: string): Job | undefined {
    const row = this.d.db.get<Row>("SELECT * FROM jobs WHERE idempotency_key = ?", key);
    return row ? toJob(row) : undefined;
  }

  get(id: string): Job | undefined {
    const row = this.d.db.get<Row>("SELECT * FROM jobs WHERE id = ?", id);
    return row ? toJob(row) : undefined;
  }

  /**
   * Ce qui est prêt à être exécuté, du plus ancien au plus récent.
   *
   * M7 : avant de rendre la liste, une exécution encore `running` dont la PRISE (`started_at`) date de plus
   * que `stalledAfterMs` est requalifiée — sinon un `onRun` qui ne rend jamais la main laissait la ligne
   * `running` pour toujours, donc invisible ici, et le runner ne reprenait plus rien.
   */
  due(at = this.at()): Job[] {
    this.requalifyStalled(at);
    return this.d.db
      .all<Row>("SELECT * FROM jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at", at)
      .map(toJob);
  }

  /**
   * M7 — requalifie les exécutions bloquées : sous leur plafond de tentatives elles repartent en attente
   * (avec le même délai croissant que `fail`), au plafond elles sont parquées en échec avec la raison.
   * Rend le nombre d'exécutions requalifiées.
   */
  requalifyStalled(at = this.at(), stalledAfterMs = this.stalledAfterMs): number {
    const cutoff = at - stalledAfterMs;
    const stalled = this.d.db
      .all<Row>("SELECT * FROM jobs WHERE status = 'running' AND COALESCE(started_at, updated_at) < ?", cutoff)
      .map(toJob);
    for (const job of stalled) {
      const error = `exécution bloquée (aucun résultat depuis ${Math.round(stalledAfterMs / 1000)} s)`;
      // La prise est effacée dans les deux cas : la ligne quitte l'état `running`, donc plus aucun
      // horodatage de prise ne doit rester (sinon une relecture croirait à une exécution en vol).
      if (job.attempts >= job.maxAttempts) {
        this.d.db.run(
          "UPDATE jobs SET status = 'failed', last_error = ?, started_at = NULL, updated_at = ? WHERE id = ?",
          error,
          at,
          job.id,
        );
      } else {
        this.d.db.run(
          "UPDATE jobs SET status = 'pending', last_error = ?, due_at = ?, started_at = NULL, updated_at = ? WHERE id = ?",
          error,
          at + this.delay(job.attempts),
          at,
          job.id,
        );
      }
    }
    return stalled.length;
  }

  /**
   * Prend une exécution. La condition de statut est dans le `WHERE` : une seconde prise sur la même
   * ligne ne peut pas réussir, et on le vérifie en relisant plutôt qu'en le supposant.
   */
  claim(id: string, at = this.at()): Job | null {
    const before = this.get(id);
    if (before?.status !== "pending") return null;
    this.d.db.run(
      "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      at,
      at,
      id,
    );
    const after = this.get(id);
    if (after?.status !== "running" || after.attempts !== before.attempts + 1) return null;
    return after;
  }

  complete(id: string, result?: string, at = this.at()): void {
    this.d.db.run(
      "UPDATE jobs SET status = 'done', result = ?, last_error = NULL, started_at = NULL, updated_at = ? WHERE id = ?",
      result ?? null,
      at,
      id,
    );
  }

  /**
   * Enregistre un échec. Sous le plafond, l'exécution revient en attente avec un délai plus long ;
   * au plafond, elle est parquée en échec avec l'erreur gardée — jamais perdue, jamais en boucle.
   */
  fail(id: string, error: string, at = this.at()): { job: Job | undefined; willRetry: boolean } {
    const job = this.get(id);
    if (!job) return { job: undefined, willRetry: false };
    if (job.attempts >= job.maxAttempts) {
      this.d.db.run(
        "UPDATE jobs SET status = 'failed', last_error = ?, started_at = NULL, updated_at = ? WHERE id = ?",
        error,
        at,
        id,
      );
      return { job: this.get(id), willRetry: false };
    }
    this.d.db.run(
      "UPDATE jobs SET status = 'pending', last_error = ?, due_at = ?, started_at = NULL, updated_at = ? WHERE id = ?",
      error,
      at + this.delay(job.attempts),
      at,
      id,
    );
    return { job: this.get(id), willRetry: true };
  }

  /**
   * Au démarrage : tout ce qui est encore « running » vient d'un processus mort en vol. On le remet
   * en attente, et on dit combien — une reprise silencieuse serait indistinguable d'un abandon.
   */
  recover(at = this.at(), retry: (job: Job) => boolean = () => true): number {
    const stranded = this.d.db.all<Row>("SELECT * FROM jobs WHERE status = 'running'").map(toJob);
    for (const job of stranded) {
      // Ce qui a son propre rattrapage (une tâche planifiée a déjà son prochain tour) est clos en
      // échec, avec la raison : le remettre en attente le ferait tourner deux fois.
      this.d.db.run(
        "UPDATE jobs SET status = ?, last_error = 'interrompu par un arrêt', updated_at = ? WHERE id = ?",
        retry(job) ? "pending" : "failed",
        at,
        job.id,
      );
    }
    return stranded.length;
  }

  /**
   * Retire les exécutions TERMINÉES (faites ou échouées) de plus de `olderThanMs`, en gardant
   * toujours les `keep` plus récentes. Rien en attente ni en cours n'est jamais touché. Une clé
   * d'idempotence tombe avec sa ligne : au-delà de ce délai, un rejeu serait un nouveau travail.
   */
  prune({ keep = 1_000, olderThanMs = 30 * 24 * 3_600_000, at = this.at() } = {}): number {
    return this.d.db.run(
      `DELETE FROM jobs WHERE status IN ('done', 'failed') AND updated_at < ? AND id NOT IN (
         SELECT id FROM jobs WHERE status IN ('done', 'failed') ORDER BY updated_at DESC LIMIT ?)`,
      at - olderThanMs,
      keep,
    ).changes;
  }

  list(status?: JobStatus): Job[] {
    const rows = status
      ? this.d.db.all<Row>("SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC", status)
      : this.d.db.all<Row>("SELECT * FROM jobs ORDER BY created_at DESC");
    return rows.map(toJob);
  }

  /**
   * Les exécutions les plus récentes, BORNÉES par le haut. `list()` est l'inventaire complet, et il
   * n'y a pas de purge : sur un profil qui tourne des mois, l'inventaire grandit sans fin. Une vue
   * qui se rafraîchit à la demande ne peut donc pas passer par lui — elle tirerait toute la table
   * pour n'en montrer qu'une page, et l'écran attendrait.
   *
   * Le tri est celui de `list()` (la plus récente d'abord), avec `rowid` en départage : deux
   * exécutions mises en file dans la même milliseconde sortiraient sinon dans un ordre arbitraire, et
   * la même vue montrerait deux ordres différents d'un rafraîchissement à l'autre.
   */
  recent(limit = 50): Job[] {
    const borne = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (borne === 0) return [];
    return this.d.db.all<Row>("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?", borne).map(toJob);
  }

  stats(): Record<JobStatus, number> {
    const counts: Record<JobStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const row of this.d.db.all<{ status: JobStatus; n: number }>(
      "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status",
    )) {
      counts[row.status] = row.n;
    }
    return counts;
  }
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    kind: row.kind,
    payload: safeParse(row.payload),
    ref: row.ref,
    idempotencyKey: row.idempotency_key,
    dueAt: row.due_at,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    result: row.result,
    startedAt: row.started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
