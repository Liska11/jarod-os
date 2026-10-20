// Cockpit, lot 2 : permissions par outil ET par cible, et autorisations temporaires (une échéance, puis la règle ne joue plus).
import { describe, expect, it } from "vitest";
import { PermissionGuard, rulesWeakenings, targetMatches, unifiedGate } from "../src/guard.js";

describe("cible d'une règle", () => {
  it("motif insensible à la casse, « * » pour n'importe quelle suite, séparateurs de chemin équivalents", () => {
    expect(targetMatches("*steam*", "Steam")).toBe(true);
    expect(targetMatches("C:\\Users\\me\\Documents\\*", "c:/users/me/documents/a.txt")).toBe(true);
    expect(targetMatches("https://exemple.fr/*", "https://exemple.fr/page")).toBe(true);
    expect(targetMatches("https://exemple.fr/*", "https://exemple.fr.evil.com/")).toBe(false);
    expect(targetMatches("notepad", "notepad++")).toBe(false);
    // Les caractères spéciaux des expressions régulières sont pris à la lettre.
    expect(targetMatches("a.b", "axb")).toBe(false);
  });

  it("une règle ciblée ne joue que pour sa cible ; la première qui couvre gagne", () => {
    const g = new PermissionGuard([
      { tool: "system_open", target: "*steam*", decision: "deny" },
      { tool: "system_open", decision: "allow" },
    ]);
    expect(g.match("system_open", "Steam")).toBe("deny");
    expect(g.match("system_open", "Bloc-notes")).toBe("allow");
  });

  it("cible inconnue (l'outil n'a pas su la dire) : une règle ciblée deny ou ask s'applique telle quelle, un allow ciblé ne joue pas (fail-closed)", () => {
    const deny = new PermissionGuard([{ tool: "system_open", target: "*steam*", decision: "deny" }]);
    expect(deny.match("system_open", null)).toBe("deny");
    const allow = new PermissionGuard([{ tool: "system_open", target: "*steam*", decision: "allow" }]);
    expect(allow.match("system_open", null)).toBeNull();
  });

  it("sans contexte de cible (vue d'ensemble) : un deny ou ask ciblé vaut « demander », un allow ciblé ne joue pas", () => {
    const g = new PermissionGuard([{ tool: "system_open", target: "*steam*", decision: "deny" }]);
    expect(g.match("system_open")).toBe("ask");
    const a = new PermissionGuard([{ tool: "system_open", target: "*", decision: "allow" }]);
    expect(a.match("system_open")).toBeNull();
  });

  it("le portail unifié transmet la cible", () => {
    const gate = unifiedGate(new PermissionGuard([{ tool: "write_file", target: "*.env", decision: "deny" }]), () => true);
    expect(gate.decide("write_file", "config/.env")).toBe("deny");
    expect(gate.decide("write_file", "notes.md")).toBe("allow");
  });
});

describe("autorisation temporaire", () => {
  it("une règle échue ne joue plus ; avant l'échéance elle joue", () => {
    let now = 1_000;
    const g = new PermissionGuard([{ tool: "run_shell", decision: "allow", expiresAt: 2_000 }], () => now);
    expect(g.match("run_shell")).toBe("allow");
    now = 2_000;
    expect(g.match("run_shell")).toBeNull();
  });
});

describe("affaiblissements à confirmer", () => {
  it("un allow ciblé nouveau est un affaiblissement, nommé avec sa cible ; un deny ciblé n'en est pas un", () => {
    const before = [{ tool: "system_open", decision: "ask" as const }];
    expect(rulesWeakenings(before, [{ tool: "system_open", target: "*steam*", decision: "allow" }, ...before]).join()).toMatch(/system_open.*steam/);
    expect(rulesWeakenings(before, [{ tool: "system_open", target: "*steam*", decision: "deny" }, ...before])).toEqual([]);
  });

  it("une autorisation temporaire reste un affaiblissement tant qu'elle n'est pas échue", () => {
    const star = { tool: "*", decision: "deny" as const };
    const changes = rulesWeakenings([star], [{ tool: "run_shell", decision: "allow", expiresAt: Date.now() + 3_600_000 }, star]);
    expect(changes.join()).toMatch(/run_shell/);
  });
});
