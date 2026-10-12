// Tests du garde unifié (portage SANK-AI agent-host.mjs:36-56) : correspondance, fail-closed, et — AV2-008 —
// règles de l'utilisateur relues à chaud + mesure des affaiblissements.
import { describe, expect, it } from "vitest";
import type { PermissionRule } from "@jarod/contracts";
import { loadRulesFromStorage, PermissionGuard, rulesWeakenings, unifiedGate } from "../src/guard.js";
import type { SettingsService } from "@jarod/plugin-storage";

/** Le strict nécessaire de `SettingsService` pour `loadRulesFromStorage` : une clé et rien d'autre. */
const fakeSettings = (v: unknown, throwOnRead = false): SettingsService =>
  ({
    get: () => {
      if (throwOnRead) throw new Error("base fermée");
      return v;
    },
  }) as unknown as SettingsService;

describe("PermissionGuard (first-match-wins, fail-closed)", () => {
  it("sans aucune règle, tout est refusé", () => {
    expect(new PermissionGuard().decide("read_file")).toBe("deny");
  });

  it("la première règle qui couvre l'outil gagne", () => {
    const g = new PermissionGuard([
      { tool: "write_file", decision: "deny" },
      { tool: "*", decision: "allow" },
    ]);
    expect(g.decide("write_file")).toBe("deny");
    expect(g.decide("read_file")).toBe("allow");
  });

  it("`_` et `/` sont équivalents, et un segment couvre la famille", () => {
    const g = new PermissionGuard([
      { tool: "fs/write", decision: "ask" },
      { tool: "github", decision: "deny" },
    ]);
    expect(g.decide("fs_write")).toBe("ask");
    expect(g.decide("github_prs")).toBe("deny");
    expect(g.match("web_search")).toBeNull();
  });

  it("chaîne effective : règles, puis « déclaré → allow », puis `* → deny`", () => {
    const declared = new Set(["read_file", "run_shell"]);
    const gate = unifiedGate(new PermissionGuard([{ tool: "run_shell", decision: "ask" }]), (n) => declared.has(n));
    expect(gate.decide("run_shell")).toBe("ask");
    expect(gate.decide("read_file")).toBe("allow");
    expect(gate.decide("outil_invente")).toBe("deny");
  });
});

describe("AV2-008 — règles de l'utilisateur lues dans le storage", () => {
  it("lit `permissionsRules`, et toute lecture impossible vaut « aucune règle » (jamais une exception)", () => {
    expect(loadRulesFromStorage(fakeSettings([{ tool: "run_shell", decision: "deny" }]))).toEqual([{ tool: "run_shell", decision: "deny" }]);
    expect(loadRulesFromStorage(fakeSettings(undefined))).toEqual([]);
    expect(loadRulesFromStorage(fakeSettings("pas une liste"))).toEqual([]);
    expect(loadRulesFromStorage(fakeSettings(null, true))).toEqual([]);
  });

  it("la copie rendue ne partage pas la mémoire du réglage (l'écriture suivante ne peut pas déplacer les règles par effet de bord)", () => {
    const stored: PermissionRule[] = [{ tool: "run_shell", decision: "deny" }];
    const rules = loadRulesFromStorage(fakeSettings(stored));
    stored.push({ tool: "*", decision: "allow" });
    expect(rules).toEqual([{ tool: "run_shell", decision: "deny" }]);
  });

  it("`setRules` remplace EN PLACE : un portail déjà distribué à l'agent suit la relecture à chaud", () => {
    const guard = new PermissionGuard([]);
    const gate = unifiedGate(guard, () => true);
    expect(gate.decide("run_shell")).toBe("allow"); // déclaré au registre, aucune règle : rien ne change
    guard.setRules([{ tool: "run_shell", decision: "deny" }]);
    expect(gate.decide("run_shell")).toBe("deny");
    expect(gate.decide("read_file")).toBe("allow");
    guard.setRules([]);
    expect(gate.decide("run_shell")).toBe("allow");
  });

  it("les règles rendues sont une copie : `getRules()` ne permet pas de les modifier sans passer par `setRules`", () => {
    const guard = new PermissionGuard([{ tool: "a", decision: "deny" }]);
    (guard.getRules() as { tool: string; decision: string }[]).push({ tool: "*", decision: "allow" });
    expect(guard.decide("b")).toBe("deny");
  });
});

describe("AV2-008 — `rulesWeakenings` : ce qui exige la confirmation native", () => {
  it("durcir, ou ne rien changer, n'exige rien", () => {
    expect(rulesWeakenings([], [{ tool: "run_shell", decision: "deny" }])).toEqual([]);
    expect(rulesWeakenings([{ tool: "a", decision: "allow" }], [{ tool: "a", decision: "deny" }])).toEqual([]);
    expect(rulesWeakenings([{ tool: "a", decision: "ask" }], [{ tool: "a", decision: "deny" }])).toEqual([]);
    expect(rulesWeakenings([{ tool: "a", decision: "ask" }], [{ tool: "a", decision: "ask" }])).toEqual([]);
  });

  it("lever un refus, ou alléger une demande, est un affaiblissement — nommé", () => {
    expect(rulesWeakenings([{ tool: "a", decision: "deny" }], [])).toEqual([`règle « a » : « deny » devient « allow »`]);
    expect(rulesWeakenings([{ tool: "a", decision: "ask" }], [{ tool: "a", decision: "allow" }])).toEqual([`règle « a » : « ask » devient « allow »`]);
    expect(rulesWeakenings([], [{ tool: "a", decision: "allow" }])).toEqual([`règle « a » : « deny » devient « allow » pour un outil que le registre ne déclare pas`]);
  });

  it("la règle générale `*` est mesurée à part : c'est elle qui décide tout ce qu'aucun nom ne couvre", () => {
    expect(rulesWeakenings([], [{ tool: "*", decision: "allow" }])).toHaveLength(1);
    expect(rulesWeakenings([], [{ tool: "*", decision: "allow" }])[0]).toMatch(/règle générale « \* ».*« deny » devient « allow »/);
    expect(rulesWeakenings([{ tool: "*", decision: "deny" }], [])[0]).toMatch(/règle générale « \* »/);
    expect(rulesWeakenings([{ tool: "*", decision: "allow" }], [{ tool: "*", decision: "deny" }])).toEqual([]);
  });

  it("un nom ne produit qu'une phrase, et l'ordre des règles compte (first-match-wins)", () => {
    const one = rulesWeakenings([], [{ tool: "a", decision: "ask" }]);
    expect(one).toHaveLength(1);
    // `a` refuse, mais `*` autorise : le nom `a` est couvert par la première règle, pas par le joker.
    expect(rulesWeakenings([{ tool: "a", decision: "deny" }, { tool: "*", decision: "deny" }], [{ tool: "a", decision: "allow" }, { tool: "*", decision: "deny" }])).toHaveLength(1);
  });
});
