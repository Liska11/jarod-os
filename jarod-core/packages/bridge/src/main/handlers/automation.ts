/**
 * Automation IPC handlers : CRUD règles + exécution manuelle.
 * Délégué au plugin `automation` (ctx.automation).
 * SPECS-P5-AUTOMATION.md §2.3 (outils agent) + canaux IPC §5.
 */
import {
  AutomationCreateInput,
  AutomationUpdateInput,
  type AutomationRule,
  type AutomationListResponse,
  type AutomationRunResult,
  type AutomationTrigger,
  type AutomationAction,
} from "@jarod/contracts";
import { nextCronRun } from "@jarod/plugin-scheduler";
import type { HandlerContext } from "./context.js";

/** Une entrée IPC mal formée est refusée avec le chemin fautif, jamais castée (AV2-007). */
function dit(canal: string, e: { issues: { path: PropertyKey[]; message: string }[] }): Error {
  const detail = e.issues.map((i) => `${i.path.map(String).join(".") || "(racine)"} : ${i.message}`).join(" ; ");
  return new Error(`[oneai] ${canal} : entrée invalide — ${detail}`);
}

/** Un cron illisible est refusé À L'ÉCRITURE : sinon la règle échoue en silence à chaque tick. */
function verifierCron(canal: string, trigger: { kind: string; cron?: string } | undefined): void {
  if (trigger?.kind !== "schedule" || trigger.cron === undefined) return;
  try {
    nextCronRun(trigger.cron, Date.now());
  } catch (e) {
    throw new Error(`[oneai] ${canal} : cron invalide « ${trigger.cron} » : ${(e as Error).message}`);
  }
}

function toContractRule(rule: import("@jarod/plugin-automation").AutomationRule): AutomationRule {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    trigger: rule.trigger as AutomationTrigger,
    actions: rule.actions as AutomationAction[],
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function getAutomation(ctx: HandlerContext) {
  const a = ctx.kernel().automation;
  if (!a) throw new Error("[oneai] automation non disponible (plugin automation désactivé)");
  return a;
}

export function createAutomationHandlers(ctx: HandlerContext) {
  const automation = () => getAutomation(ctx);

  return {
    "automation-list": (): AutomationListResponse => {
      const rules = automation().list();
      return { rules: rules.map(toContractRule) };
    },

    "automation-create": (input: unknown): AutomationRule => {
      const parsed = AutomationCreateInput.safeParse(input);
      if (!parsed.success) throw dit("automation-create", parsed.error);
      verifierCron("automation-create", parsed.data.trigger);
      const rule = automation().create(parsed.data);
      return toContractRule(rule);
    },

    "automation-get": (id: unknown): AutomationRule | null => {
      if (typeof id !== "string") throw new Error("[oneai] automation-get : id invalide");
      const rule = automation().get(id);
      return rule ? toContractRule(rule) : null;
    },

    "automation-update": (id: unknown, input: unknown): AutomationRule => {
      if (typeof id !== "string") throw new Error("[oneai] automation-update : id invalide");
      const parsed = AutomationUpdateInput.safeParse(input);
      if (!parsed.success) throw dit("automation-update", parsed.error);
      verifierCron("automation-update", parsed.data.trigger);
      const rule = automation().update(id, parsed.data);
      if (!rule) throw new Error(`[oneai] automation-update : règle introuvable : ${id}`);
      return toContractRule(rule);
    },

    "automation-delete": (id: unknown): boolean => {
      if (typeof id !== "string") throw new Error("[oneai] automation-delete : id invalide");
      return automation().delete(id);
    },

    "automation-run": async (id: unknown): Promise<AutomationRunResult> => {
      if (typeof id !== "string") throw new Error("[oneai] automation-run : id invalide");
      const result = await automation().run(id);
      return { ok: result.ok, jobId: undefined, error: result.ok ? undefined : result.summary };
    },
  };
}