/**
 * Jarod-cordis (G4, décision 2026-09-28) : plafond de tokens/coût par conversation. Aucun
 * équivalent dans les sources (Jarod-one comptait sans plafonner — gap-reel.md G4 ; Kama-One et
 * SANK-AI n'ont que des budgets de temps/caractères) : code neuf, au-dessus du compteur existant.
 *
 * Règles : alerte à 80 % (un statut, au franchissement), arrêt du tour à 100 % (vérifié avant
 * chaque appel du modèle — un appel en cours peut dépasser, sa sortie n'est pas connue d'avance) ;
 * on poursuit en relevant le plafond de la conversation (`/budget`). Coût inconnu (modèle hors
 * barème, local) : seul le plafond de tokens joue.
 */
import type { BudgetLimits, Message, SessionBudgetConfig } from "@jarod/contracts";
import { estimateCost } from "@jarod/plugin-llm";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
}

export const WARN_RATIO = 0.8;

/** Somme des réponses de l'assistant (corps de `core.ts:1629-1654`, partagé avec `sessionUsage`). */
export function usageOf(messages: readonly Message[]): SessionUsage {
  let cost: number | null = null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    input += m.inputTokens ?? 0;
    output += m.outputTokens ?? 0;
    cacheRead += m.cacheReadTokens ?? 0;
    const c = estimateCost(
      m.model,
      m.inputTokens ?? 0,
      m.outputTokens ?? 0,
      m.cacheReadTokens ?? 0,
      m.cacheWriteTokens ?? 0,
    );
    if (c !== null) cost = (cost ?? 0) + c;
  }
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, costUsd: cost };
}

/** Le plafond qui s'applique : celui de la conversation s'il a été relevé, sinon le global. */
export function limitsFor(cfg: SessionBudgetConfig | undefined, sessionId: string): BudgetLimits {
  const own = cfg?.perSession?.[sessionId];
  return {
    maxTokens: Math.max(0, own?.maxTokens ?? cfg?.maxTokens ?? 0),
    maxCostUsd: Math.max(0, own?.maxCostUsd ?? cfg?.maxCostUsd ?? 0),
  };
}

/** La part consommée du plafond (la plus haute des deux dimensions actives) ; null = aucun plafond actif. */
export function budgetRatio(u: SessionUsage, l: BudgetLimits): number | null {
  const parts: number[] = [];
  if (l.maxTokens > 0) parts.push((u.inputTokens + u.outputTokens) / l.maxTokens);
  if (l.maxCostUsd > 0 && u.costUsd !== null) parts.push(u.costUsd / l.maxCostUsd);
  return parts.length ? Math.max(...parts) : null;
}

const fmt = (n: number) => n.toLocaleString("fr-FR");

/** « 8 200 / 10 000 tokens · ~0,41 / 0,50 $ » — seulement les dimensions actives. */
export function describeBudget(u: SessionUsage, l: BudgetLimits): string {
  const parts: string[] = [];
  if (l.maxTokens > 0) parts.push(`${fmt(u.inputTokens + u.outputTokens)} / ${fmt(l.maxTokens)} tokens`);
  if (l.maxCostUsd > 0) {
    parts.push(
      u.costUsd === null
        ? `coût inconnu pour ce modèle / ${l.maxCostUsd} $`
        : `~${u.costUsd.toFixed(4)} / ${l.maxCostUsd} $`,
    );
  }
  return parts.length ? parts.join(" · ") : "aucun plafond";
}

export const budgetStopMessage = (u: SessionUsage, l: BudgetLimits): string =>
  `Plafond de la conversation atteint (${describeBudget(u, l)}). Pour poursuivre, relevez-le : \`/budget <tokens> [<usd>]\`.`;

export const budgetWarnMessage = (u: SessionUsage, l: BudgetLimits): string =>
  `${Math.round(WARN_RATIO * 100)} % du plafond de la conversation atteint (${describeBudget(u, l)}).`;

/**
 * Le franchissement de 80 % par la DERNIÈRE réponse : sans état, donc une seule alerte par
 * franchissement, même après un redémarrage (la réponse précédente était sous le seuil).
 */
export function crossedWarning(messages: readonly Message[], l: BudgetLimits): boolean {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      last = i;
      break;
    }
  }
  if (last < 0) return false;
  const now = budgetRatio(usageOf(messages), l);
  const before = budgetRatio(usageOf(messages.filter((_, i) => i !== last)), l);
  return now !== null && before !== null && now >= WARN_RATIO && now < 1 && before < WARN_RATIO;
}
