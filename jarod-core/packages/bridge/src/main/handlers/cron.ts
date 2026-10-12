/**
 * Tâches planifiées aux formes hermesAPI, sur le `Scheduler` (plugin-scheduler).
 * Sources des formes : SANK-UI `src/main/cronjobs.ts:18-33` (`CronJob`), `:38-70` (`normalizeJob` :
 * état, « local » par défaut), `:360-480` (création / retrait / pause / reprise / exécution →
 * `{ success, error }`), `ipc/register.ts:2901-2931` (rév. 3aaadb0, MIT © github.com/fathah).
 *
 * Horaires Hermes (`hermes cron create <horaire>`) → `ScheduleSpec` Jarod :
 *   « every 30m|2h|1d » → intervalle ; « 30m|2h|1d » → une fois, dans ce délai ;
 *   expression cron à 5 champs → cron ; date ISO → une fois à cette date. Tout autre format est refusé.
 * Livraison Hermes « local » | « <passerelle>:<chat> » ↔ `ScheduleDelivery` ; une passerelle sans chat
 * est refusée (Jarod exige le chat, pas de devinette).
 */
import type { Schedule, ScheduleDelivery, ScheduleSpec } from "@jarod/plugin-scheduler";
import { DELIVERY_GATEWAYS } from "@jarod/plugin-scheduler";
import { assertProfile, type HandlerContext } from "./context.js";

type Result = { success: boolean; error?: string };

const UNIT_MIN: Record<string, number> = { m: 1, h: 60, d: 1440 };

export function parseHermesSchedule(raw: string, at = Date.now()): ScheduleSpec {
  const s = raw.trim();
  const every = /^every\s+(\d+)\s*([mhd])$/i.exec(s);
  if (every) return { kind: "interval", minutes: Number(every[1]) * UNIT_MIN[every[2]!.toLowerCase()]! };
  const delay = /^(\d+)\s*([mhd])$/i.exec(s);
  if (delay) return { kind: "once", at: at + Number(delay[1]) * UNIT_MIN[delay[2]!.toLowerCase()]! * 60_000 };
  if (s.split(/\s+/).length === 5 && /^[\d*/,\-\sA-Za-z]+$/.test(s)) return { kind: "cron", expr: s };
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return { kind: "once", at: t };
  }
  throw new Error(`Horaire non reconnu : « ${raw} » (every 30m, 2h, expression cron à 5 champs ou date ISO)`);
}

/** L'horaire tel que l'écran Hermes l'affiche (`schedule_display`). */
export function hermesScheduleDisplay(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case "interval":
      return spec.minutes % 1440 === 0 ? `every ${spec.minutes / 1440}d` : spec.minutes % 60 === 0 ? `every ${spec.minutes / 60}h` : `every ${spec.minutes}m`;
    case "daily": {
      const [h, m] = spec.time.split(":");
      return `${Number(m)} ${Number(h)} * * ${spec.days?.length ? spec.days.join(",") : "*"}`;
    }
    case "cron":
      return spec.expr;
    case "once":
      return new Date(spec.at).toISOString();
  }
}

export function parseHermesDeliver(raw: unknown): ScheduleDelivery | null {
  if (raw === undefined || raw === null || raw === "" || raw === "local") return null;
  if (typeof raw !== "string") throw new Error("Livraison invalide");
  const [gateway, ...rest] = raw.split(":");
  const chatId = rest.join(":").trim();
  if (!DELIVERY_GATEWAYS.includes(gateway as ScheduleDelivery["gateway"])) throw new Error(`Livraison non prise en charge : « ${raw} »`);
  if (!chatId) throw new Error(`Livraison « ${gateway} » : précisez le chat (« ${gateway}:<identifiant> »)`);
  return { gateway: gateway as ScheduleDelivery["gateway"], chatId };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function toCronJob(s: Schedule) {
  const failed = s.lastStatus !== null && s.lastStatus !== "ok";
  return {
    id: s.id,
    name: s.name,
    schedule: hermesScheduleDisplay(s.spec),
    prompt: s.prompt,
    state: s.enabled ? ("active" as const) : s.spec.kind === "once" && s.lastRun !== null ? ("completed" as const) : ("paused" as const),
    enabled: s.enabled,
    next_run_at: iso(s.nextRun),
    last_run_at: iso(s.lastRun),
    last_status: s.lastStatus === null ? null : failed ? "error" : "ok",
    last_error: failed ? s.lastStatus : null,
    repeat: s.spec.kind === "once" ? { times: 1, completed: s.lastRun !== null ? 1 : 0 } : null,
    deliver: s.deliver ? [`${s.deliver.gateway}:${s.deliver.chatId}`] : ["local"],
    skills: [] as string[],
    script: null,
  };
}

export function createCronHandlers(ctx: HandlerContext) {
  const scheduler = () => ctx.kernel().scheduler;
  const attempt = (profile: unknown, fn: () => void): Result => {
    try {
      assertProfile(ctx, profile);
      fn();
      return { success: true };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  };
  const existing = (jobId: unknown): Schedule => {
    const s = typeof jobId === "string" && jobId ? scheduler().get(jobId) : undefined;
    if (!s) throw new Error(typeof jobId === "string" && jobId ? `Tâche inconnue : ${jobId}` : "Missing job ID");
    return s;
  };
  const setEnabled = (jobId: unknown, enabled: boolean) => {
    const s = existing(jobId);
    scheduler().save({ id: s.id, name: s.name, prompt: s.prompt, spec: s.spec, enabled });
  };

  return {
    "list-cron-jobs": (includeDisabled?: unknown, profile?: unknown) => {
      assertProfile(ctx, profile);
      return scheduler()
        .list()
        .filter((s) => includeDisabled === true || s.enabled)
        .map(toCronJob);
    },
    "create-cron-job": (schedule: unknown, prompt?: unknown, name?: unknown, deliver?: unknown, profile?: unknown): Result =>
      attempt(profile, () => {
        if (typeof schedule !== "string") throw new Error("Horaire requis");
        const text = typeof prompt === "string" ? prompt : "";
        scheduler().save({
          name: typeof name === "string" && name.trim() ? name : text.slice(0, 60),
          prompt: text,
          spec: parseHermesSchedule(schedule),
          deliver: parseHermesDeliver(deliver),
        });
      }),
    "remove-cron-job": (jobId: unknown, profile?: unknown): Result => attempt(profile, () => scheduler().delete(existing(jobId).id)),
    "pause-cron-job": (jobId: unknown, profile?: unknown): Result => attempt(profile, () => setEnabled(jobId, false)),
    "resume-cron-job": (jobId: unknown, profile?: unknown): Result => attempt(profile, () => setEnabled(jobId, true)),
    // `hermes cron run` : l'exécution part, la réponse n'attend pas le tour d'agent (runNow journalise son statut).
    "trigger-cron-job": (jobId: unknown, profile?: unknown): Result => attempt(profile, () => void scheduler().runNow(existing(jobId).id)),
  };
}
