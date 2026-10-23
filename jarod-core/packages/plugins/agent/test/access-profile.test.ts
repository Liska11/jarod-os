// V-09 — les préréglages de profil d'accès : la table de décision, sans kernel (la porte réelle : access-profile.engine.test.ts).
import { describe, expect, it } from "vitest";
import { type AccessProfile, autonomyHonoured, HARD_LIMITS, isAccessProfile, NEVER_ALWAYS, needsApproval, profilePower } from "../src/index.js";

const ask = (profile: AccessProfile, tool: string, o: { dangerous?: boolean; verdict?: "allow" | "ask"; auto?: boolean; always?: boolean } = {}) =>
  needsApproval({ profile, tool, dangerous: o.dangerous ?? false, verdict: o.verdict ?? "allow", autoApproveTools: o.auto ?? false, alwaysAllowed: o.always ?? false });

describe("V-09 — profils d'accès", () => {
  it("Demander : tout demande, lectures comprises, malgré « Toujours » et l'interrupteur global ; aucune autonomie par règle", () => {
    expect(ask("ask", "read_file")).toBe(true);
    expect(ask("ask", "write_file", { dangerous: true, auto: true, always: true })).toBe(true);
    expect(autonomyHonoured("ask")).toBe(false);
  });

  it("M'approuver : les sensibles demandent (l'interrupteur global ignoré), les lectures passent, « Toujours » joue", () => {
    expect(ask("approve", "read_file")).toBe(false);
    expect(ask("approve", "write_file", { dangerous: true, auto: true })).toBe(true);
    expect(ask("approve", "write_file", { dangerous: true, always: true })).toBe(false);
    expect(autonomyHonoured("approve")).toBe(true);
  });

  it("Plein : rien ne demande, sauf chaque limite dure — et une règle « demander » demande toujours", () => {
    expect(ask("full", "write_file", { dangerous: true })).toBe(false);
    for (const tool of HARD_LIMITS) expect(ask("full", tool, { dangerous: true, auto: true, always: true }), tool).toBe(true);
    expect(ask("full", "read_file", { verdict: "ask" })).toBe(true);
  });

  it("les limites dures sont exactement les outils sans « Toujours autoriser » (décisions de l'utilisateur), dont run_shell et system_files", () => {
    expect([...HARD_LIMITS].sort()).toEqual([...NEVER_ALWAYS].sort());
    expect(HARD_LIMITS.has("run_shell")).toBe(true);
    expect(HARD_LIMITS.has("system_files")).toBe(true);
  });

  it("Personnalisé : exactement le comportement d'avant (interrupteur global, « Toujours », règles)", () => {
    expect(ask("custom", "write_file", { dangerous: true })).toBe(true);
    expect(ask("custom", "write_file", { dangerous: true, auto: true })).toBe(false);
    expect(ask("custom", "write_file", { dangerous: true, always: true })).toBe(false);
    expect(ask("custom", "read_file")).toBe(false);
    expect(ask("custom", "read_file", { verdict: "ask" })).toBe(true);
  });

  it("le pouvoir de chaque profil, pour savoir ce qui affaiblit ; une valeur inconnue n'est pas un profil", () => {
    expect(profilePower("ask", true)).toBeLessThan(profilePower("approve", true));
    expect(profilePower("approve", false)).toBeLessThan(profilePower("full", false));
    expect(profilePower("custom", false)).toBe(profilePower("approve", false));
    expect(profilePower("custom", true)).toBe(profilePower("full", false));
    expect(isAccessProfile("full")).toBe(true);
    expect(isAccessProfile("root")).toBe(false);
    expect(isAccessProfile(undefined)).toBe(false);
  });
});
