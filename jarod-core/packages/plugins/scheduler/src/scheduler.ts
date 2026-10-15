import type { Db } from "@jarod/plugin-storage";
import { Emitter, newId, now, parseJson } from "@jarod/kernel/util";
import { nextCronRun, parseCron } from "./cron.js";
import type { JobsService } from "./jobs.js";

export type ScheduleSpec =
  | { kind: "interval"; minutes: number }
  /** Local time `HH:MM`; `days` uses 0 = Sunday … 6 = Saturday (all days when omitted). */
  | { kind: "daily"; time: string; days?: number[] }
  /** Five-field cron expression, local time (see `cron.ts`). */
  | { kind: "cron"; expr: string }
  /** A single run at `at` (ms); the schedule switches itself off once it has fired. */
  | { kind: "once"; at: number };

/** Where a run's answer is also sent: a chat of one of the messaging gateways. */
export interface ScheduleDelivery {
  gateway: "telegram" | "discord" | "slack" | "email" | "whatsapp";
  chatId: string;
}

export const DELIVERY_GATEWAYS: ScheduleDelivery["gateway"][] = ["telegram", "discord", "slack", "email", "whatsapp"];

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  spec: ScheduleSpec;
  /** Conversation the runs are appended to (created on first run). */
  sessionId: string | null;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
  lastStatus: string | null;
  createdAt: number;
  /** Jamais rangé : mode imposé à un tour lancé hors planificateur (automation) ; absent = mode de la conversation. */
  mode?: "plan" | "build";
  /** Also send each run's answer to this chat (null: the app's notification only). */
  deliver: ScheduleDelivery | null;
}

interface Row {
  id: string;
  name: string;
  prompt: string;
  spec: string;
  session_id: string | null;
  enabled: number;
  last_run: number | null;
  next_run: number | null;
  last_status: string | null;
  created_at: number;
  gateway: string | null;
  chat_id: string | null;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  name: r.name,
  prompt: r.prompt,
  spec: parseJson<ScheduleSpec>(r.spec, { kind: "interval", minutes: 60 }),
  sessionId: r.session_id,
  enabled: r.enabled === 1,
  lastRun: r.last_run,
  nextRun: r.next_run,
  lastStatus: r.last_status,
  createdAt: r.created_at,
  deliver: r.gateway && r.chat_id ? { gateway: r.gateway as ScheduleDelivery["gateway"], chatId: r.chat_id } : null,
});

const SELECT = `SELECT s.*, d.gateway, d.chat_id FROM schedules s
  LEFT JOIN schedule_deliveries d ON d.schedule_id = s.id`;

export function validateDelivery(d: ScheduleDelivery | null): ScheduleDelivery | null {
  if (!d) return null;
  if (!DELIVERY_GATEWAYS.includes(d.gateway)) throw new Error(`Messagerie inconnue : ${String(d.gateway)}`);
  const chatId = String(d.chatId ?? "").trim();
  if (!chatId) throw new Error("Identifiant de discussion requis pour la livraison.");
  return { gateway: d.gateway, chatId };
}

export function validateSpec(spec: ScheduleSpec): ScheduleSpec {
  if (spec.kind === "interval") {
    const minutes = Math.round(Number(spec.minutes));
    if (!(minutes >= 1 && minutes <= 60 * 24 * 31)) throw new Error("Intervalle invalide (1 minute à 31 jours)");
    return { kind: "interval", minutes };
  }
  if (spec.kind === "daily") {
    const m = /^(\d{1,2}):(\d{2})$/.exec(spec.time ?? "");
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error("Heure invalide (format HH:MM)");
    const days = spec.days?.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    return {
      kind: "daily",
      time: `${m[1]!.padStart(2, "0")}:${m[2]}`,
      ...(days?.length ? { days: [...new Set(days)].sort() } : {}),
    };
  }
  if (spec.kind === "cron") {
    const expr = String(spec.expr ?? "").trim();
    parseCron(expr);
    nextCronRun(expr, Date.now());
    return { kind: "cron", expr };
  }
  if (spec.kind === "once") {
    const at = Math.round(Number(spec.at));
    if (!Number.isFinite(at) || at <= 0) throw new Error("Date invalide");
    return { kind: "once", at };
  }
  throw new Error("Type de planification inconnu");
}

/** Next run strictly after `from`, or null when there is none left (a one-off already past). */
export function nextRunAfter(spec: ScheduleSpec, from: number): number | null {
  if (spec.kind === "once") return spec.at > from ? spec.at : null;
  return computeNextRun(spec, from);
}

/** Next run strictly after `from` (local time for daily and cron schedules; a one-off gives its date). */
export function computeNextRun(spec: ScheduleSpec, from: number): number {
  if (spec.kind === "interval") return from + spec.minutes * 60_000;
  if (spec.kind === "cron") return nextCronRun(spec.expr, from);
  if (spec.kind === "once") return spec.at;
  const [h, m] = spec.time.split(":").map(Number) as [number, number];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(h, m);
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > from && (!spec.days || spec.days.includes(d.getDay()))) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return d.getTime();
}

export function describeSpec(spec: ScheduleSpec): string {
  if (spec.kind === "interval") {
    return spec.minutes % 1440 === 0
      ? `toutes les ${spec.minutes / 1440 === 1 ? "24 h" : `${spec.minutes / 1440} jours`}`
      : spec.minutes % 60 === 0
        ? `toutes les ${spec.minutes / 60} h`
        : `toutes les ${spec.minutes} min`;
  }
  if (spec.kind === "cron") return `cron « ${spec.expr} »`;
  if (spec.kind === "once") return `une fois, le ${new Date(spec.at).toLocaleString("fr-FR")}`;
  const names = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
  return `chaque ${spec.days ? spec.days.map((d) => names[d]).join(", ") : "jour"} à ${spec.time}`;
}

export type ScheduleRunner = (schedule: Schedule) => Promise<{ sessionId: string; ok: boolean; summary: string }>;

/** Runs prompts on a schedule while the app is open (missed runs fire once at startup). */
export class Scheduler extends Emitter<{ changed: Schedule[] }> {
  private timer: NodeJS.Timeout | null = null;
  /** Les horaires servis en ce moment, avec l'instant du départ (voir `purgeStalledRunning`). */
  private running = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly runner: ScheduleRunner,
  ) {
    super();
  }

  list(): Schedule[] {
    return this.db.all<Row>(`${SELECT} ORDER BY s.created_at`).map(toSchedule);
  }

  get(id: string): Schedule | undefined {
    const r = this.db.get<Row>(`${SELECT} WHERE s.id = ?`, id);
    return r && toSchedule(r);
  }

  /**
   * Creates or updates a schedule. `deliver` left undefined keeps what the schedule already had (a
   * screen that does not know about delivery must not erase it); `null` removes it.
   */
  save(input: {
    id?: string;
    name: string;
    prompt: string;
    spec: ScheduleSpec;
    enabled?: boolean;
    deliver?: ScheduleDelivery | null;
  }): Schedule {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name) throw new Error("Nom requis");
    if (!prompt) throw new Error("Consigne requise");
    const spec = validateSpec(input.spec);
    const existing = input.id ? this.get(input.id) : undefined;
    const deliver = input.deliver === undefined ? (existing?.deliver ?? null) : validateDelivery(input.deliver);
    const next = nextRunAfter(spec, now());
    if (spec.kind === "once" && next === null && (input.enabled ?? true)) {
      throw new Error("Cette date est déjà passée.");
    }
    const enabled = (input.enabled ?? true) && next !== null;
    const id = existing?.id ?? input.id ?? newId();
    if (existing) {
      this.db.run(
        "UPDATE schedules SET name = ?, prompt = ?, spec = ?, enabled = ?, next_run = ? WHERE id = ?",
        name,
        prompt,
        JSON.stringify(spec),
        enabled ? 1 : 0,
        enabled ? next : null,
        existing.id,
      );
    } else {
      this.db.run(
        "INSERT INTO schedules (id, name, prompt, spec, enabled, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        name,
        prompt,
        JSON.stringify(spec),
        enabled ? 1 : 0,
        enabled ? next : null,
        now(),
      );
    }
    if (deliver) {
      this.db.run(
        "INSERT INTO schedule_deliveries (schedule_id, gateway, chat_id) VALUES (?, ?, ?) ON CONFLICT(schedule_id) DO UPDATE SET gateway = excluded.gateway, chat_id = excluded.chat_id",
        id,
        deliver.gateway,
        deliver.chatId,
      );
    } else {
      this.db.run("DELETE FROM schedule_deliveries WHERE schedule_id = ?", id);
    }
    this.emit("changed", this.list());
    return this.get(id)!;
  }

  delete(id: string): void {
    this.db.run("DELETE FROM schedules WHERE id = ?", id);
    this.emit("changed", this.list());
  }

  start(tickMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), tickMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // R3.5 — à l'arrêt, plus aucun tick ne viendra : on libère les places au lieu de laisser des
    // exécutions « en cours » dans un planificateur qui ne tourne plus. Un runner qui se règlerait
    // plus tard ne se croira plus propriétaire (`mine`, dans `runNow`).
    this.running.clear();
  }

  /** La file durable. Sans elle, une exécution planifiée meurt avec le processus qui l'a lancée. */
  private jobs: JobsService | null = null;

  /** Attache la file. Le planificateur garde son runner : c'est la même exécution, mais tracée. */
  attachJobs(jobs: JobsService): void {
    this.jobs = jobs;
  }

  /**
   * M7 (§3.6-2) — le délai au-delà duquel une exécution qui n'a jamais rendu la main est déclarée
   * bloquée. C'est celui de la file, pour que la même panne se lise de la même façon des deux côtés
   * (et 15 minutes par défaut quand le planificateur tourne sans file).
   */
  get stalledAfterMs(): number {
    return this.jobs?.stalledAfterMs ?? 15 * 60_000;
  }

  /**
   * M7 (§3.6-2) — `running.delete` n'est atteint que si le runner se règle : un runner qui ne rend
   * jamais la main laissait donc l'identifiant en place et l'horaire ne repartait plus JAMAIS, alors
   * que `jobs.ts` sait déjà requalifier une exécution bloquée. On libère les exécutions qui dépassent
   * le délai, pour que l'horaire reparte au tick suivant au lieu de rester « en cours » pour toujours.
   */
  private purgeStalledRunning(at: number): void {
    for (const [id, startedAt] of this.running) {
      if (at - startedAt >= this.stalledAfterMs) this.running.delete(id);
    }
  }

  /**
   * R3.5 — la borne d'UNE exécution. Au-delà du délai de la file, le tir est déclaré terminé : statut
   * « délai dépassé », place libérée, issue écrite. Sans elle, un runner qui ne rend jamais la main
   * gardait la place jusqu'au tick suivant ; avec elle, le retour tardif est un perdant de course muet
   * (même patron que `WebhookRunner.withTimeout`), donc il ne réécrit plus `session_id` ni `last_status`
   * par-dessus un tir repris entre-temps.
   */
  private async withExecutionBound<T>(promise: Promise<T>, id: string): Promise<T> {
    const ms = this.stalledAfterMs;
    promise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`délai dépassé (${Math.round(ms / 1000)} s) — ${id}`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Runs every enabled schedule whose time has come. Exposed for tests. */
  async tick(at = now()): Promise<void> {
    this.purgeStalledRunning(at);
    const due = this.list().filter(
      (s) => s.enabled && s.nextRun !== null && s.nextRun <= at && !this.running.has(s.id),
    );
    await Promise.all(due.map((s) => this.runNow(s.id, at)));
  }

  async runNow(id: string, at = now()): Promise<void> {
    this.purgeStalledRunning(at);
    const s = this.get(id);
    if (!s || this.running.has(id)) return;
    this.running.set(id, at);
    // L'exécution est d'abord ÉCRITE : si l'application s'arrête en cours, elle repart en `pending`
    // au démarrage au lieu de disparaître sans trace. La clé d'idempotence porte l'instant du tir,
    // donc un tick rejoué (même horaire, même instant) ne produit pas une seconde exécution.
    const key = `schedule:${id}:${at}`;
    this.jobs?.enqueue({ kind: "schedule", payload: { scheduleId: id, at }, idempotencyKey: key, maxAttempts: 2 });
    // On relit par clé plutôt que de supposer la forme de ce que `enqueue` rend.
    const job = this.jobs?.byKey(key);
    // Un instant déjà servi ne se sert pas deux fois : sans ce retour, un tick rejoué aurait laissé
    // une seule ligne mais aurait bel et bien retravaillé. La ligne n'est pas la garantie ; le
    // travail l'est. Le prochain tir de l'horaire a un autre instant, donc une autre clé.
    if (job && job.status !== "pending" && job.status !== "running") {
      this.running.delete(id);
      return;
    }
    const claimed = job ? this.jobs?.claim(job.id) : null;
    // Schedule the next run first so a crash never makes it fire in a loop. A one-off has none
    // left after this, so it switches itself off.
    const next = s.enabled ? nextRunAfter(s.spec, at) : null;
    this.db.run(
      "UPDATE schedules SET next_run = ?, last_run = ?, enabled = ? WHERE id = ?",
      next,
      at,
      s.enabled && next !== null ? 1 : 0,
      id,
    );
    let status: string;
    let mine = true;
    try {
      // R3.5 — l'exécution est BORNÉE par le même délai que celui de la file : un runner qui ne rend
      // jamais la main ne garde plus la place jusqu'au tick suivant, et son retour tardif ne réécrit
      // plus rien (voir `withExecutionBound`).
      const r = await this.withExecutionBound(this.runner(s), id);
      // Le perdant de la course peut se régler APRÈS la borne : sa place a été reprise, donc ce n'est
      // plus la sienne, et il n'écrit pas par-dessus le tir qui a repris l'horaire.
      if (this.running.get(id) === at) this.db.run("UPDATE schedules SET session_id = ? WHERE id = ?", r.sessionId, id);
      status = r.ok ? "ok" : `erreur : ${r.summary.slice(0, 200)}`;
    } catch (e) {
      status = `erreur : ${(e as Error).message.slice(0, 200)}`;
    } finally {
      // Regardé AVANT de libérer : c'est ce qui distingue « notre tir se termine » de « un tick a
      // déclaré le nôtre bloqué et en a repris un autre ».
      mine = this.running.get(id) === at;
      // Seulement si c'est encore NOTRE départ : une exécution déclarée bloquée puis reprise par un
      // tick suivant ne doit pas libérer la place de la nouvelle en se réglant après coup.
      if (mine) this.running.delete(id);
    }
    // Un tir plus récent occupe la place (et a déjà écrit son état) : le nôtre se tait.
    if (!mine) return;
    // On referme l'exécution avec son issue, succès comme échec : un échec reste un fait accompli.
    // La file ne relance pas — l'horaire a son propre prochain tir, et retenter ici le doublerait.
    if (this.jobs && claimed) this.jobs.complete(claimed.id, status);
    this.db.run("UPDATE schedules SET last_status = ? WHERE id = ?", status, id);
    this.emit("changed", this.list());
  }
}
