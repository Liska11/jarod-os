// Règles de permissions modifiées depuis Réglages ou par `jarod permissions edit/move` (2026-10-21) : le même service que l'ajout et la
// révocation — modification en place, déplacement, nombre d'utilisations réservé aux autorisations, et la relecture avant écriture qui ne rend
// jamais une utilisation consommée pendant la confirmation.
import type { PermissionRule } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { normalizeRules, planGrant, planMove, planUpdate, rebaseRules } from "../src/admin.js";

const NOW = 1_800_000_000_000;
const DEMO: PermissionRule = { tool: "system_files", decision: "allow", autonomous: true, target: "D:\\demo\\*", uses: 3, id: "p-demo01", createdAt: NOW - 1, by: "commande" };
const STOP: PermissionRule = { tool: "run_shell", decision: "deny", id: "p-shell1" };

describe("modification d'une règle en place", () => {
  it("garde l'identifiant, la position et la date de création ; dit avant et après ; note le canal", () => {
    const p = planUpdate([STOP, DEMO], "p-demo01", { uses: 5, durationMs: 3_600_000, by: "réglages" }, NOW);
    expect(p.rules[1]).toMatchObject({ id: "p-demo01", createdAt: NOW - 1, uses: 5, expiresAt: NOW + 3_600_000, by: "réglages", target: "D:\\demo\\*" });
    expect(p.rules[0]).toEqual(STOP);
    expect(p.summary[0]).toMatch(/^Avant : p-demo01 — autoriser SANS accord.*3 utilisation/);
    expect(p.summary[1]).toMatch(/^Après : .*5 utilisation/);
    // Plus d'utilisations = plus de pouvoir : annoncé comme un affaiblissement (la confirmation native le liste).
    expect(p.weakenings.length).toBeGreaterThan(0);
  });

  it("retirer une borne (null) ; une autonomie qui perd sa dernière borne exige le choix large", () => {
    const one: PermissionRule = { tool: "media_fetch", decision: "allow", autonomous: true, target: "*.youtube.com", id: "p-media1" };
    expect(() => planUpdate([one], "p-media1", { target: null }, NOW)).toThrow(/sans aucune borne/);
    expect(planUpdate([one], "p-media1", { target: null, broad: true }, NOW).rules[0]).not.toHaveProperty("target");
    expect(planUpdate([DEMO], "1", { durationMs: null, uses: null, target: "D:\\demo2\\*" }, NOW).rules[0]).toMatchObject({ target: "D:\\demo2\\*" });
  });

  it("passer de « sans accord » à « refuser » retire l'autonomie et durcit (aucune confirmation) ; durée hors bornes refusée", () => {
    const p = planUpdate([DEMO], "p-demo01", { decision: "deny", uses: null }, NOW);
    expect(p.rules[0]).toMatchObject({ decision: "deny" });
    expect(p.rules[0]).not.toHaveProperty("autonomous");
    expect(p.weakenings).toEqual([]);
    expect(() => planUpdate([DEMO], "p-demo01", { durationMs: 31 * 86_400_000 }, NOW)).toThrow(/30 jours/);
    expect(() => planUpdate([DEMO], "p-absent", { uses: 1 }, NOW)).toThrow(/Aucune règle/);
  });

  it("un nombre d'utilisations ne borne qu'une autorisation : refusé sur un refus ou une demande", () => {
    expect(() => normalizeRules([{ tool: "x", decision: "deny", uses: 2 }], NOW)).toThrow(/seulement avec allow/);
    expect(() => planUpdate([DEMO], "p-demo01", { decision: "ask" }, NOW)).toThrow(/seulement avec allow/);
    expect(() => planGrant([], { tool: "x", decision: "ask", uses: 2 }, NOW)).toThrow(/seulement avec allow/);
  });

  it("remplacer une autorisation de même périmètre par une plus longue est annoncé", () => {
    const p = planGrant([DEMO], { tool: "system_files", decision: "allow", autonomous: true, target: "D:\\demo\\*", uses: 50 }, NOW);
    expect(p.summary.join("\n")).toMatch(/Remplace : p-demo01/);
    expect(p.weakenings.join("\n")).toMatch(/3 → 50 utilisation/);
  });

  it("un ajout depuis l'écran est noté « réglages », depuis la commande « commande »", () => {
    expect(planGrant([], { tool: "x", decision: "deny", by: "réglages" }, NOW).rules[0]!.by).toBe("réglages");
    expect(planGrant([], { tool: "x", decision: "deny" }, NOW).rules[0]!.by).toBe("commande");
  });
});

describe("déplacement", () => {
  it("monter une autorisation au-dessus d'un refus qui la couvrait l'affaiblit ; la descendre durcit", () => {
    const allow: PermissionRule = { tool: "run_shell", decision: "allow", target: "D:\\demo\\*", id: "p-allow1" };
    const up = planMove([STOP, allow], "p-allow1", 1, NOW);
    expect(up.rules.map((r) => r.id)).toEqual(["p-allow1", "p-shell1"]);
    expect(up.weakenings.join("\n")).toMatch(/run_shell.*deny.*allow/);
    expect(planMove(up.rules, "p-allow1", 2, NOW).weakenings).toEqual([]);
  });
});

describe("relecture avant écriture", () => {
  it("une utilisation consommée pendant la confirmation n'est pas rendue", () => {
    const base = [DEMO, STOP];
    const planned = planUpdate(base, "p-shell1", { decision: "ask" }, NOW).rules;
    const fresh = [{ ...DEMO, uses: 2 }, STOP];
    expect(rebaseRules(base, fresh, planned)[0]!.uses).toBe(2);
  });

  it("le nombre que l'utilisateur vient de fixer l'emporte sur le compteur relu", () => {
    const base = [DEMO];
    const planned = planUpdate(base, "p-demo01", { uses: 10 }, NOW).rules;
    expect(rebaseRules(base, [{ ...DEMO, uses: 1 }], planned)[0]!.uses).toBe(10);
  });

  it("une liste changée autrement entre-temps (autre écran, commande) : rien n'est écrit", () => {
    const base = [DEMO];
    const planned = planUpdate(base, "p-demo01", { uses: 10 }, NOW).rules;
    expect(() => rebaseRules(base, [DEMO, STOP], planned)).toThrow(/ont changé pendant la confirmation/);
    expect(() => rebaseRules(base, [{ ...DEMO, target: "C:\\*" }], planned)).toThrow(/ont changé/);
  });
});
