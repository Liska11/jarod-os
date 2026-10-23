// Autonomie configurable (2026-10-21) : périmètres (cibles, opération, conversation, échéance, utilisations), « sans accord », affaiblissements,
// et le module d'administration (validation commune, ajout, révocation, réinitialisation, explication).
import type { PermissionRule } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { explainResolution, normalizeRules, planGrant, planReset, planRevoke, reservedReason } from "../src/admin.js";
import { PermissionGuard, resolveWith, rulesWeakenings } from "../src/guard.js";

const NOW = 1_800_000_000_000;
const guard = (rules: PermissionRule[], now = NOW) => new PermissionGuard(rules, () => now);
const DEMO: PermissionRule = { tool: "system_files", decision: "allow", autonomous: true, target: "D:\\demo\\*", id: "p-demo01" };

describe("garde : périmètre d'une autorisation sans accord", () => {
  it("joue seulement si TOUTES les cibles sont dans le périmètre ; une cible dehors, inconnue ou absente : pas d'autonomie", () => {
    const g = guard([DEMO]);
    expect(g.resolveRule("system_files", { targets: ["D:\\demo\\a.txt", "d:/demo/sub/a.txt"] })).toMatchObject({ decision: "allow", autonomous: true });
    expect(g.resolveRule("system_files", { targets: ["D:\\demo\\a.txt", "D:\\autre\\a.txt"] })).toBeNull();
    expect(g.resolveRule("system_files", { targets: null })).toBeNull();
    expect(g.resolveRule("system_files", {})).toBeNull();
  });

  it("une cible qui remonte (`..`) ne satisfait jamais une règle qui ouvre ; un refus la voit", () => {
    expect(guard([DEMO]).resolveRule("system_files", { targets: ["D:\\demo\\..\\Users\\x"] })).toBeNull();
    expect(guard([{ tool: "system_files", decision: "deny", target: "D:\\demo\\*" }]).resolveRule("system_files", { targets: ["D:\\demo\\..\\x"] })?.decision).toBe("deny");
  });

  it("refus : il suffit qu'UNE cible soit couverte", () => {
    const g = guard([{ tool: "system_files", decision: "deny", target: "C:\\Windows\\*" }, DEMO]);
    expect(g.resolveRule("system_files", { targets: ["D:\\demo\\a", "C:\\Windows\\b"] })?.decision).toBe("deny");
  });

  it("opération : « subtitles » accordée sans accord n'accorde pas « audio »", () => {
    const g = guard([{ tool: "media_fetch", decision: "allow", autonomous: true, operation: "subtitles", target: "*.youtube.com" }]);
    expect(g.resolveRule("media_fetch", { targets: ["www.youtube.com"], operation: "subtitles" })?.autonomous).toBe(true);
    expect(g.resolveRule("media_fetch", { targets: ["www.youtube.com"], operation: "audio" })).toBeNull();
    expect(g.resolveRule("media_fetch", { targets: ["www.youtube.com"], operation: null })).toBeNull();
  });

  it("conversation : une règle de mission ne joue que dans sa conversation", () => {
    const g = guard([{ ...DEMO, session: "s-1" }]);
    expect(g.resolveRule("system_files", { targets: ["D:\\demo\\a"], session: "s-1" })?.autonomous).toBe(true);
    expect(g.resolveRule("system_files", { targets: ["D:\\demo\\a"], session: "s-2" })).toBeNull();
  });

  it("échéance et utilisations : une règle échue ou épuisée ne joue plus, la suivante décide", () => {
    const ask: PermissionRule = { tool: "system_files", decision: "ask" };
    expect(guard([{ ...DEMO, expiresAt: NOW - 1 }, ask]).resolveRule("system_files", { targets: ["D:\\demo\\a"] })?.decision).toBe("ask");
    expect(guard([{ ...DEMO, uses: 0 }, ask]).resolveRule("system_files", { targets: ["D:\\demo\\a"] })?.decision).toBe("ask");
    expect(guard([{ ...DEMO, uses: 1 }, ask]).resolveRule("system_files", { targets: ["D:\\demo\\a"] })?.autonomous).toBe(true);
  });

  it("« allow » sans `autonomous` garde l'accord ; repli du registre : jamais autonome", () => {
    const res = resolveWith(guard([{ tool: "system_files", decision: "allow", target: "D:\\demo\\*" }]), () => true, "system_files", { targets: ["D:\\demo\\a"] });
    expect(res).toMatchObject({ decision: "allow", autonomous: false, source: "règle" });
    expect(resolveWith(guard([]), () => true, "system_files", { targets: ["D:\\demo\\a"] })).toMatchObject({ autonomous: false, source: "registre" });
  });

  it("affaiblissements : passer à « sans accord », étendre les utilisations, ou allonger le périmètre est un affaiblissement", () => {
    const allow = { ...DEMO, autonomous: undefined } as PermissionRule;
    delete (allow as { autonomous?: true }).autonomous;
    expect(rulesWeakenings([allow], [DEMO])).toEqual([`règle « system_files » sur « D:\\demo\\* » : « allow » devient « allow sans accord »`]);
    expect(rulesWeakenings([{ ...DEMO, uses: 0 }], [{ ...DEMO, uses: 5 }]).length).toBeGreaterThan(0);
    expect(rulesWeakenings([DEMO], [{ ...DEMO, operation: "move" }])).toEqual([]);
    expect(rulesWeakenings([DEMO], [])).toEqual([]);
  });
});

describe("administration : une seule validation, ajout, révocation, réinitialisation", () => {
  it("la validation commune accepte les nouveaux champs et refuse les incohérences", () => {
    expect(normalizeRules([DEMO, { tool: "media_fetch", decision: "allow", operation: "subtitles", uses: 3, session: "abc-1" }], NOW)).toHaveLength(2);
    expect(() => normalizeRules([{ tool: "x", decision: "deny", autonomous: true }], NOW)).toThrow(/autonomous/);
    expect(() => normalizeRules([{ tool: "x", decision: "allow", operation: "a b" }], NOW)).toThrow(/opération/);
    expect(() => normalizeRules([DEMO, { ...DEMO, id: "p-autre1" }], NOW)).toThrow(/en double/);
    expect(() => normalizeRules([{ tool: "x", decision: "allow", inconnu: 1 }], NOW)).toThrow(/inconnue/);
  });

  it("ajout : une autonomie sans borne est refusée sauf choix large explicite ; la règle passe en tête et dit ce qui reste actif", () => {
    expect(() => planGrant([], { tool: "run_shell", decision: "allow", autonomous: true }, NOW)).toThrow(/sans aucune borne/);
    const wide = planGrant([], { tool: "run_shell", decision: "allow", autonomous: true, broad: true }, NOW);
    expect(wide.weakenings.join("\n")).toMatch(/allow sans accord/);
    const p = planGrant([{ tool: "*", decision: "deny" }], { tool: "system_files", decision: "allow", autonomous: true, target: "D:\\demo\\*", durationMs: 3_600_000, uses: 5 }, NOW);
    expect(p.rules[0]).toMatchObject({ tool: "system_files", autonomous: true, uses: 5, expiresAt: NOW + 3_600_000, by: "commande" });
    expect(p.rules[0]!.id).toMatch(/^p-[0-9a-f]{6}$/);
    expect(p.summary.join("\n")).toMatch(/Restent actifs : interrupteur Internet, mode Plan/);
    expect(p.weakenings.length).toBeGreaterThan(0);
  });

  it("révocation par id ou position ; réinitialisation : les refus retirés sont annoncés comme des affaiblissements", () => {
    const rules: PermissionRule[] = [DEMO, { tool: "run_shell", decision: "deny", id: "p-shell1" }];
    expect(planRevoke(rules, "p-demo01", NOW).rules).toEqual([rules[1]]);
    expect(planRevoke(rules, "2", NOW).rules).toEqual([DEMO]);
    expect(() => planRevoke(rules, "p-absent", NOW)).toThrow(/Aucune règle/);
    const reset = planReset(rules, NOW);
    expect(reset.rules).toEqual([]);
    expect(reset.weakenings.join("\n")).toMatch(/run_shell.*deny/);
  });

  it("explication : « je sais faire, mais cette permission manque » — jamais « je ne sais pas »", () => {
    const g = guard([{ tool: "system_files", decision: "deny", id: "p-nofile" }]);
    const deny = explainResolution("system_files", { targets: ["D:\\x"] }, resolveWith(g, () => true, "system_files", { targets: ["D:\\x"] }), { exists: true, dangerous: true }, NOW);
    expect(deny.verdict).toBe("refusé");
    expect(deny.why).toMatch(/^Je sais faire « system_files », mais une règle de permissions le refuse/);
    expect(deny.howTo).toMatch(/jarod permissions revoke p-nofile/);
    const ask = explainResolution("media_fetch", { targets: ["www.youtube.com"], operation: "subtitles" }, resolveWith(guard([]), () => true, "media_fetch", {}), { exists: true, dangerous: true }, NOW);
    expect(ask.verdict).toBe("accord demandé");
    expect(ask.howTo).toMatch(/jarod permissions add auto media_fetch --cible www\.youtube\.com --operation subtitles --duree 1j/);
    const none = explainResolution("outil_invente", {}, resolveWith(guard([]), () => false, "outil_invente", {}), { exists: false, dangerous: false }, NOW);
    expect(none.why).toMatch(/la capacité n'existe pas/);
  });

  it("opération réservée : accordée seulement par une règle qui la couvre, pas par un joker « * » posé pour autre chose", () => {
    const reserved = { sql: "lit tout" };
    const call = { operation: "sql" };
    expect(reservedReason(resolveWith(guard([]), () => true, "system_diagnostics", call), "sql", reserved)).toBe("lit tout");
    expect(reservedReason(resolveWith(guard([{ tool: "*", decision: "allow" }]), () => true, "system_diagnostics", call), "sql", reserved)).toBe("lit tout");
    expect(reservedReason(resolveWith(guard([{ tool: "system_diagnostics", decision: "allow", operation: "sql" }]), () => true, "system_diagnostics", call), "sql", reserved)).toBeNull();
    expect(reservedReason(resolveWith(guard([]), () => true, "system_diagnostics", { operation: "disks" }), "disks", reserved)).toBeNull();
  });
});
