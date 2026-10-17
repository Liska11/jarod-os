/**
 * Exécuteur déterministe d'un plan (phase 6B). Il ne connaît aucun outil : chaque étape part par `execute`, que
 * l'appelant branche sur `executeGuardedTool` (permissions par outil, accord, confinement, audit). Sans `execute`, rien
 * ne tourne. Échec fermé : la première erreur arrête le plan, puis le retour arrière s'exécute.
 */
import { digestOf, type Condition, type Plan, type PlanStep, pathProblem } from "./recipe.js";
import { substituteDeep, type Vars } from "./template.js";

export interface PlanCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LedgerEntry {
  step: string;
  tool: string | null;
  /** SHA-256 des arguments : le journal ne contient jamais le contenu. */
  argsDigest: string;
  outcome: "ok" | "error" | "skipped" | "refused";
}

export interface RunContext {
  execute(call: PlanCall): Promise<{ content: string; isError: boolean }>;
  vars?: Vars;
  record?: (entry: LedgerEntry) => void;
}

export interface RunResult {
  ok: boolean;
  completed: number;
  skipped: number;
  failedStep?: string;
  error?: string;
  rolledBack?: boolean;
  vars: Vars;
}

/** Ce qui peut être inséré dans une ligne de commande : pas de métacaractère shell, pas de saut de ligne, pas d'accolade. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,.\/\\ -]*$/;
const MAX_SAVED = 64_000;
const PATH_TOOLS = new Set(["read_file", "write_file", "list_dir"]);

function holds(when: Condition | undefined, vars: Vars): boolean {
  if (!when) return true;
  const v = Object.hasOwn(vars, when.var) ? vars[when.var] : undefined;
  if ("equals" in when) return v === when.equals;
  if ("notEquals" in when) return v !== when.notEquals;
  return (v !== undefined) === when.exists;
}

function pure(step: PlanStep, vars: Vars): void {
  const a = substituteDeep(step.args, vars);
  if (step.verb === "set" && step.save) vars[step.save] = String(a.value ?? "").slice(0, MAX_SAVED);
  else if (step.verb === "json.get" && step.save) {
    const from = Object.hasOwn(vars, String(a.from)) ? vars[String(a.from)] : undefined;
    let cur: unknown;
    try {
      cur = JSON.parse(from ?? "");
    } catch {
      throw new Error("json.get : la variable ne contient pas du JSON");
    }
    for (const k of String(a.key).split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
    if (typeof cur !== "string" && typeof cur !== "number" && typeof cur !== "boolean") throw new Error("json.get : valeur absente ou non scalaire");
    vars[step.save] = String(cur).slice(0, MAX_SAVED);
  }
}

async function runSteps(steps: PlanStep[], ctx: RunContext, vars: Vars, state: { completed: number; skipped: number }): Promise<{ failedStep: string; error: string } | null> {
  for (const step of steps) {
    const ledger = (outcome: LedgerEntry["outcome"]) => ctx.record?.({ step: step.id, tool: step.tool, argsDigest: digestOf(step.args), outcome });
    if (!holds(step.when, vars)) {
      state.skipped++;
      ledger("skipped");
      continue;
    }
    try {
      if (step.tool === null) {
        pure(step, vars);
        state.completed++;
        ledger("ok");
        continue;
      }
      // Seules les valeurs d'une ligne de commande sont contrôlées : le texte de la recette, lui, est signé.
      const check = step.tool === "run_shell" ? (value: string, name: string) => {
        if (!SHELL_SAFE.test(value)) throw new Error(`la variable ${name} contient des caractères non sûrs pour un shell`);
      } : undefined;
      const args = substituteDeep(step.args, vars, check);
      if (PATH_TOOLS.has(step.tool) && typeof args.path === "string") {
        const p = pathProblem(args.path);
        if (p) throw new Error(`chemin refusé (${p})`);
      }
      const res = await ctx.execute({ id: step.id, name: step.tool, args });
      if (res.isError) {
        ledger("error");
        return { failedStep: step.id, error: res.content.slice(0, 500) };
      }
      if (step.save) vars[step.save] = res.content.slice(0, MAX_SAVED);
      state.completed++;
      ledger("ok");
    } catch (e) {
      ledger("refused");
      return { failedStep: step.id, error: (e as Error).message };
    }
  }
  return null;
}

export async function runPlan(plan: Plan, ctx: RunContext): Promise<RunResult> {
  const vars: Vars = { ...(ctx.vars ?? {}) };
  const state = { completed: 0, skipped: 0 };
  const failure = await runSteps(plan.steps, ctx, vars, state);
  if (!failure) return { ok: true, ...state, vars };
  let rolledBack: boolean | undefined;
  if (plan.rollback.length) {
    const undo = await runSteps(plan.rollback, ctx, vars, { completed: 0, skipped: 0 });
    rolledBack = undo === null;
  }
  return { ok: false, ...state, ...failure, ...(rolledBack === undefined ? {} : { rolledBack }), vars };
}
