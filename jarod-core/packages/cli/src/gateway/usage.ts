// Passerelle compatible Hermes (essai) : la page « Usage » de Herald lit `GET /api/analytics/usage` (jetons et coût par jour et par modèle). Jarod range les
// jetons de chaque réponse de l'assistant dans la table des messages : ce module en tire le relevé, sans rien stocker de plus. Pur (une liste de lignes → un relevé).
import { estimateCost } from "@jarod/plugin-llm";

export interface UsageRow {
  session_id: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  created_at: number;
}

export interface Analytics {
  daily: { day: string; input_tokens: number; output_tokens: number; sessions: number; estimated_cost: number | null }[];
  by_model: { model: string; input_tokens: number; output_tokens: number; sessions: number }[];
  totals: { total_input: number; total_output: number; total_estimated_cost: number | null; total_actual_cost: null; total_sessions: number };
  period_days: number;
}

/** La requête qui ramène les lignes de la période (les seules réponses de l'assistant portent des jetons). */
export const USAGE_SQL = `SELECT session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at
  FROM messages WHERE role = 'assistant' AND created_at >= ? AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`;

const pad = (n: number) => String(n).padStart(2, "0");
/** Le jour LOCAL (`AAAA-MM-JJ`) : « aujourd'hui » est celui de l'utilisateur, pas celui d'UTC. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Le jour local qui ouvre la période de `days` jours finissant aujourd'hui (aujourd'hui compris). */
export function periodStart(days: number, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.getTime();
}

/** `days` : entier entre 1 et 365 (7 par défaut) ; autre chose est une erreur de l'appelant. */
export function parseDays(raw: string | null): number {
  if (raw === null || raw === "") return 7;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new Error("days doit être un entier entre 1 et 365");
  return n;
}

/**
 * Le relevé de la période. Les jours sans rien sont présents, à zéro (un graphique les veut). Le coût n'est estimé que pour les modèles dont le prix est connu ;
 * un jour où aucun modèle n'a de prix connu a un coût `null`, pas zéro. `total_actual_cost` est toujours `null` : Jarod ne reçoit pas de facture du fournisseur.
 */
export function analytics(rows: readonly UsageRow[], days: number, now: number): Analytics {
  const start = periodStart(days, now);
  const byDay = new Map<string, { input: number; output: number; sessions: Set<string>; cost: number | null }>();
  for (let i = 0; i < days; i++) byDay.set(dayKey(start + i * 86_400_000 + 12 * 3_600_000), { input: 0, output: 0, sessions: new Set(), cost: null });
  const byModel = new Map<string, { input: number; output: number; sessions: Set<string> }>();
  const allSessions = new Set<string>();
  let cost: number | null = null;
  let input = 0;
  let output = 0;

  for (const r of rows) {
    if (r.created_at < start || r.created_at > now) continue;
    const i = r.input_tokens ?? 0;
    const o = r.output_tokens ?? 0;
    const day = byDay.get(dayKey(r.created_at));
    if (!day) continue;
    day.input += i;
    day.output += o;
    day.sessions.add(r.session_id);
    const c = estimateCost(r.model ?? undefined, i, o, r.cache_read_tokens ?? 0, r.cache_write_tokens ?? 0);
    if (c !== null) {
      day.cost = (day.cost ?? 0) + c;
      cost = (cost ?? 0) + c;
    }
    const model = r.model || "unknown";
    const m = byModel.get(model) ?? { input: 0, output: 0, sessions: new Set<string>() };
    m.input += i;
    m.output += o;
    m.sessions.add(r.session_id);
    byModel.set(model, m);
    allSessions.add(r.session_id);
    input += i;
    output += o;
  }

  return {
    daily: [...byDay].map(([day, v]) => ({ day, input_tokens: v.input, output_tokens: v.output, sessions: v.sessions.size, estimated_cost: v.cost })),
    by_model: [...byModel].map(([model, v]) => ({ model, input_tokens: v.input, output_tokens: v.output, sessions: v.sessions.size })).sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens)),
    totals: { total_input: input, total_output: output, total_estimated_cost: cost, total_actual_cost: null, total_sessions: allSessions.size },
    period_days: days,
  };
}
