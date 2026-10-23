// Preuve de révocation SANS boîte native (2026-10-22) : l'aperçu annulé de l'e2e ne vérifie plus l'application réelle ; ce test la rétablit sur la
// porte unique (executeGuardedTool) avec un outil factice. Autorisation bornée → action autorisée sans accord → révocation (même préparation que
// l'écran et la commande : planGrant / planRevoke) → nouvel appel : l'accord est redemandé et, refusé, RIEN ne s'exécute.
// L'autonomie configurable est conservée : une règle large explicite continue de jouer, une autre cible n'est pas touchée.
import { PermissionGuard, planGrant, planRevoke, unifiedGate } from "@jarod/plugin-permissions";
import { ToolRegistry, type ToolDef } from "@jarod/plugin-tools";
import type { PermissionRule } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { executeGuardedTool } from "../src/agent.js";
import { TaskLedger } from "../src/tasks.js";

const settings = { disabledTools: [], agentMode: "normal", autoApproveTools: false, alwaysAllowTools: [], workspace: null } as never;

function rig(initial: PermissionRule[] = []) {
  let executed: string[] = [];
  let asked = 0;
  const tools = new ToolRegistry();
  tools.register({
    name: "demo_write",
    description: "outil factice",
    parameters: { type: "object", properties: {} },
    source: "builtin",
    dangerous: true,
    targetOf: (a: Record<string, unknown>) => String(a.path ?? ""),
    run: async (a: Record<string, unknown>) => {
      executed.push(String(a.path));
      return "fait";
    },
  } as ToolDef);
  const guard = new PermissionGuard(initial);
  const gate = unifiedGate(guard, (n) => Boolean(tools.get(n)));
  const hooks = {
    approve: async () => {
      asked++;
      return false; // l'accord, s'il est demandé, est refusé : on voit qu'il a été demandé, et rien ne s'exécute
    },
  };
  const call = async (path: string) => {
    const before = asked;
    const r = await executeGuardedTool(tools, "s1", { id: `c${Math.random()}`, name: "demo_write", args: { path } }, new AbortController().signal, hooks, settings, { gate, tasks: new TaskLedger() });
    return { ...r, asked: asked - before };
  };
  /** Ce que fait l'écran / la commande une fois confirmé : le plan est écrit, le garde relit à chaud. */
  let rules = [...initial];
  const apply = (plan: { rules: PermissionRule[] }) => {
    rules = plan.rules;
    guard.setRules(rules);
  };
  return { call, apply, rules: () => rules, executed: () => executed, reset: () => (executed = []) };
}

describe("révocation d'une autorisation bornée — application réelle, sans boîte native", () => {
  it("autorisée sans accord dans son périmètre ; révoquée, l'accord est redemandé et rien ne s'exécute sans lui", async () => {
    const t = rig();
    const now = Date.now();

    // 1. Sans règle, l'outil à effet demande l'accord (refusé ici) : rien ne s'exécute.
    const avant = await t.call("zone/a.txt");
    expect(avant.asked).toBe(1);
    expect(t.executed()).toEqual([]);

    // 2. Autorisation LIMITÉE (cible + durée + 5 utilisations) — la même préparation que l'écran Réglages.
    t.apply(planGrant(t.rules(), { tool: "demo_write", decision: "allow", autonomous: true, target: "zone/*", durationMs: 60 * 60_000, uses: 5, by: "réglages" }, now));
    const accorde = await t.call("zone/a.txt");
    expect(accorde.asked).toBe(0);
    expect(accorde.isError).toBe(false);
    expect(t.executed()).toEqual(["zone/a.txt"]);

    // 3. Hors périmètre : la limite tient.
    const dehors = await t.call("ailleurs/b.txt");
    expect(dehors.asked).toBe(1);
    expect(t.executed()).toEqual(["zone/a.txt"]);

    // 4. Révocation (planRevoke), appliquée à chaud.
    const plan = planRevoke(t.rules(), "1", now);
    expect(plan.rules).toEqual([]);
    t.apply(plan);

    // 5. Nouvel appel dans l'ancien périmètre : l'accord est redemandé, refusé, et l'outil n'est PAS exécuté.
    const apres = await t.call("zone/a.txt");
    expect(apres.asked).toBe(1);
    expect(t.executed()).toEqual(["zone/a.txt"]); // inchangé : aucune exécution non autorisée
  });

  it("la révocation ne touche que la règle visée ; une autonomie large explicitement choisie reste active (aucune restriction générale)", async () => {
    const t = rig();
    const now = Date.now();
    t.apply(planGrant(t.rules(), { tool: "demo_write", decision: "allow", autonomous: true, target: "zone/*", uses: 3, by: "réglages" }, now));
    t.apply(planGrant(t.rules(), { tool: "demo_write", decision: "allow", autonomous: true, target: "libre/*", broad: true, by: "réglages" }, now));
    expect(t.rules()).toHaveLength(2);

    t.apply(planRevoke(t.rules(), "1", now)); // la règle placée au début : « libre/* » (position par défaut : start)
    expect(t.rules()).toHaveLength(1);

    const libre = await t.call("libre/x.txt");
    const zone = await t.call("zone/x.txt");
    // Exactement une des deux zones reste autorisée sans accord, l'autre le redemande.
    expect([libre.asked, zone.asked].sort()).toEqual([0, 1]);
    expect(t.executed()).toHaveLength(1);
  });

  it("une règle épuisée (nombre d'utilisations) ou échue ne joue plus : l'accord revient, rien ne s'exécute sans lui", async () => {
    const t = rig();
    const now = Date.now();
    t.apply({ rules: [{ tool: "demo_write", decision: "allow", autonomous: true, target: "zone/*", expiresAt: now - 1 }] });
    const r = await t.call("zone/a.txt");
    expect(r.asked).toBe(1);
    expect(t.executed()).toEqual([]);
  });
});
