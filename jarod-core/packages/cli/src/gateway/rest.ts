// Passerelle compatible Hermes (essai) : les routes REST qui ont un vrai service derrière dans le noyau de Jarod. Traduction PURE
// (aucune entrée-sortie), testable seule. Formes tirées des types que lit le shell (`CronJob` dans `lib/rest.ts`, `MemoryStatus` dans
// `MemoryCard.tsx`, `OAuthListResponse` dans `hermes-auth.ts`) : seuls les champs qu'il lit sont posés.
import type { ScheduleSpec } from "@jarod/contracts";

/** Ce que la passerelle lit d'un `Schedule` du planificateur de Jarod. */
export interface ScheduleLike {
  id: string;
  name: string;
  prompt: string;
  spec: ScheduleSpec;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
  lastStatus: string | null;
  /** La conversation où les exécutions s'accumulent (créée au premier passage). */
  sessionId?: string | null;
  /** Livraison vers une messagerie ; absente de ce que le shell sait afficher. */
  deliver?: unknown;
}

/** Ce que la passerelle demande au planificateur de Jarod (lecture et écriture). */
export interface SchedulerLike {
  list(): readonly ScheduleLike[];
  get(id: string): ScheduleLike | undefined;
  save(input: { id?: string; name: string; prompt: string; spec: ScheduleSpec; enabled?: boolean; deliver?: null }): ScheduleLike;
  delete(id: string): void;
  runNow(id: string): Promise<void>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** La règle de Jarod vue comme `CronJob.schedule` : le shell ne comprend que `kind`, `expr`, `minutes`, `run_at` et `display`. */
export function cronSchedule(spec: ScheduleSpec): { kind: string; display: string; expr?: string; minutes?: number; run_at?: string } {
  switch (spec.kind) {
    case "interval":
      return { kind: "interval", minutes: spec.minutes, display: `every ${spec.minutes}m` };
    case "cron":
      return { kind: "cron", expr: spec.expr, display: spec.expr };
    case "once": {
      const run_at = new Date(spec.at).toISOString();
      return { kind: "once", run_at, display: `once at ${run_at}` };
    }
    case "daily": {
      const [h = "0", m = "0"] = spec.time.split(":");
      const days = spec.days && spec.days.length > 0 && spec.days.length < 7 ? [...spec.days].sort((a, b) => a - b).join(",") : "*";
      const expr = `${Number(m)} ${Number(h)} * * ${days}`;
      return { kind: "cron", expr, display: `${pad(Number(h))}:${pad(Number(m))}${days === "*" ? " daily" : ` on ${days}`}` };
    }
  }
}

/** `GET /api/cron/jobs` : les planifications de Jarod comme des tâches Hermes. Les dates restent en millisecondes (le shell lit s ou ms). */
export function cronJobs(schedules: readonly ScheduleLike[]): Record<string, unknown>[] {
  return schedules.map((s) => {
    const schedule = cronSchedule(s.spec);
    return {
      id: s.id,
      name: s.name,
      prompt: s.prompt,
      schedule,
      schedule_display: schedule.display,
      enabled: s.enabled,
      state: s.enabled ? "scheduled" : "paused",
      next_run_at: s.enabled ? s.nextRun : null,
      last_run_at: s.lastRun,
      last_status: s.lastStatus,
      last_error: null,
      deliver: null,
      skills: [],
      profile: null,
    };
  });
}

/** `GET /api/memory` : le shell ne lit que le nombre d'entrées de la mémoire intégrée. */
export function memoryStatus(entries: number): Record<string, unknown> {
  return { builtin_files: { memory: entries, user: 0 } };
}
