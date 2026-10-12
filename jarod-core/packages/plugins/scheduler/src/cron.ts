/**
 * Five-field cron expressions (`minute hour day-of-month month day-of-week`, local time), the
 * format the agent writes when it turns "every weekday at 9" into a schedule. Supports `*`, lists,
 * ranges, steps (`*\/15`, `1-5/2`), month and day names (`jan`, `mon`), `7` for Sunday, and the
 * `@hourly @daily @weekly @monthly @yearly` shortcuts. As in classic cron, when both day fields
 * are restricted a day matches if EITHER does.
 */

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function field(src: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const value = (tok: string): number => {
    const i = names.indexOf(tok.toLowerCase());
    const n = i >= 0 ? i + nameBase : Number(tok);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Valeur hors bornes : ${tok}`);
    return n;
  };
  for (const part of src.split(",")) {
    const m = /^(\*|[\w]+(?:-[\w]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Champ cron invalide : ${part}`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`Pas invalide : ${part}`);
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const [a, b] = m[1]!.split("-");
      lo = value(a!);
      hi = b !== undefined ? value(b) : m[2] ? max : lo;
      if (hi < lo) throw new Error(`Intervalle inversé : ${part}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const raw = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5)
    throw new Error("Expression cron invalide : 5 champs attendus (minute heure jour mois jour-semaine).");
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  const days = field(dow, 0, 7, DAYS);
  if (days.delete(7)) days.add(0);
  return {
    minute: field(mi, 0, 59),
    hour: field(h, 0, 23),
    dom: field(dom, 1, 31),
    month: field(mo, 1, 12, MONTHS, 1),
    dow: days,
    domAny: dom === "*",
    dowAny: dow === "*",
  };
}

const dayMatches = (f: CronFields, d: Date): boolean => {
  const inDom = f.dom.has(d.getDate());
  const inDow = f.dow.has(d.getDay());
  if (f.domAny && f.dowAny) return true;
  if (f.domAny) return inDow;
  if (f.dowAny) return inDom;
  return inDom || inDow;
};

/** Next matching minute strictly after `from` (local time). Throws if nothing matches within 5 years. */
export function nextCronRun(expr: string, from: number): number {
  const f = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!f.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(f, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  throw new Error(`Aucune date ne correspond à « ${expr} ».`);
}
