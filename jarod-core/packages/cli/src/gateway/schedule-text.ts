// Passerelle compatible Hermes (essai) : le texte de planification que le shell envoie (« every 30m », « daily at 7am », une expression cron,
// un horodatage) lu comme une règle du planificateur de Jarod. PUR : aucune entrée-sortie, l'heure courante est un paramètre.
// Formats annoncés par le shell (`SCHEDULE_FORMATS_HINT`, cron-humanize.ts) : 'every 30m', 'every 6h', 'weekdays at 8:00',
// 'every monday 9am', 'daily at 7am', une expression cron ('0 9 * * 1-5') ou un horodatage ('2026-02-03T14:00', heure locale).
import type { ScheduleSpec } from "@jarod/contracts";

export class ScheduleTextError extends Error {}

export const FORMATS_HINT = "'every 30m', 'every 6h', 'weekdays at 8:00', 'every monday 9am', 'daily at 7am', a cron expression ('0 9 * * 1-5') or a timestamp ('2026-02-03T14:00')";

const DAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

/** « 7am », « 8:00 », « 6:30 pm », « 18:05 » → `HH:MM` ; undefined si ce n'est pas une heure. */
function clock(raw: string): string | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(raw.trim());
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const UNIT_MINUTES: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440 };

/**
 * Lit un texte de planification. Lève `ScheduleTextError` (message destiné à l'utilisateur) s'il n'est pas reconnu : jamais de
 * valeur par défaut silencieuse, une automatisation qui ne tire jamais ou à une autre heure que celle demandée est pire qu'une erreur.
 */
export function parseScheduleText(text: string, now = Date.now()): ScheduleSpec {
  const t = text.trim().replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  if (!t) throw new ScheduleTextError(`Schedule is empty. Use ${FORMATS_HINT}.`);

  const every = /^every (\d+) ?([a-z]+)$/.exec(lower);
  if (every) {
    const unit = UNIT_MINUTES[every[2]!];
    if (unit) return { kind: "interval", minutes: Number(every[1]) * unit };
  }

  const daily = /^(?:daily|every day|everyday) at (.+)$/.exec(lower);
  if (daily) {
    const time = clock(daily[1]!);
    if (time) return { kind: "daily", time };
  }
  const group = /^(weekdays|weekends) at (.+)$/.exec(lower);
  if (group) {
    const time = clock(group[2]!);
    if (time) return { kind: "daily", time, days: group[1] === "weekdays" ? [1, 2, 3, 4, 5] : [0, 6] };
  }
  const weekly = /^every ([a-z]+)(?: at)? (.+)$/.exec(lower);
  if (weekly && weekly[1]! in DAYS) {
    const time = clock(weekly[2]!);
    if (time) return { kind: "daily", time, days: [DAYS[weekly[1]!]!] };
  }

  const stamp = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (stamp) {
    const [y, mo, d, h, mi, s] = stamp.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
    const at = new Date(y, mo - 1, d, h, mi, s);
    // `new Date(2026, 1, 31)` déborde sur mars : on refuse une date qui n'existe pas.
    if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d || h > 23 || mi > 59) throw new ScheduleTextError(`'${t}' is not a valid date.`);
    if (at.getTime() <= now) throw new ScheduleTextError(`'${t}' is already in the past.`);
    return { kind: "once", at: at.getTime() };
  }

  if (t.split(" ").length === 5 && /^[\d*/,\-a-zA-Z? ]+$/.test(t)) return { kind: "cron", expr: t };

  throw new ScheduleTextError(`Unrecognised schedule '${t}'. Use ${FORMATS_HINT}.`);
}
