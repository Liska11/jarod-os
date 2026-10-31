// H6 : `usage.bars`. Hermes y met le forfait du fournisseur (Nous Portal) ; Jarod n'a pas d'abonnement à montrer. À la place : la barre du plafond de la
// conversation (`/budget`, réglage `sessionBudget`), que le noyau fait déjà respecter. Pur : des plafonds et un relevé → le modèle `UsageModel` du contrat.

export interface BudgetLimitsLike {
  maxTokens: number;
  maxCostUsd: number;
}
export interface BudgetUsageLike {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

const fmt = (n: number): string => Math.round(n).toLocaleString("fr-FR");
const money = (n: number): string => `${n.toFixed(2).replace(".", ",")} $`;

/** Une barre de forfait : `pct_used` en pourcentage, `fill_fraction` la part remplie (0 à 1, bornée). */
function bar(spent: number, total: number, show: (n: number) => string) {
  const ratio = total > 0 ? spent / total : 0;
  return {
    kind: "plan" as const,
    remaining_display: show(Math.max(0, total - spent)),
    total_display: show(total),
    spent_display: show(spent),
    pct_used: Math.min(100, ratio * 100),
    fill_fraction: Math.min(1, ratio),
  };
}

/**
 * La dimension la plus avancée l'emporte (comme l'arrêt du tour, qui suit la plus haute des deux). Sans plafond actif : `available: false`,
 * un état et non une panne — l'écran dit alors qu'il n'y a rien à mesurer.
 */
export function usageBars(title: string, limits: BudgetLimitsLike, usage: BudgetUsageLike): Record<string, unknown> {
  const tokens = usage.inputTokens + usage.outputTokens;
  const candidates: Array<{ ratio: number; unit: string; plan: ReturnType<typeof bar> }> = [];
  if (limits.maxTokens > 0) candidates.push({ ratio: tokens / limits.maxTokens, unit: "jetons", plan: bar(tokens, limits.maxTokens, fmt) });
  if (limits.maxCostUsd > 0 && usage.costUsd !== null) {
    candidates.push({ ratio: usage.costUsd / limits.maxCostUsd, unit: "coût estimé", plan: bar(usage.costUsd, limits.maxCostUsd, money) });
  }
  if (!candidates.length) return { ok: true, available: false, status: "no_cap" };
  const top = candidates.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return {
    ok: true,
    available: true,
    status: "session_budget",
    plan_name: `Plafond de la conversation « ${title} » (${top.unit})`,
    plan_bar: top.plan,
    has_topup: false,
  };
}
