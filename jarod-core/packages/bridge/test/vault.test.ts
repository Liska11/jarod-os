/**
 * SPECS-P5-UI-PARITE.md §3.2 — coffre d'identifiants depuis l'écran. Invariants : la VALEUR ne revient jamais au renderer (ni dans une liste, ni dans
 * une erreur) ; élargir où un secret peut aller (shell, nouveaux domaines) et supprimer passent par une boîte native ; rien d'invalide n'est écrit.
 * VRAI kernel, VRAIS handlers, vrai chiffrement des secrets.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

type View = { name: string; description: string; envVar: string; domains: string[]; allowShell: boolean; hasValue: boolean };
const rejects = (fn: () => unknown, why: RegExp) => expect(Promise.resolve().then(fn)).rejects.toThrow(why);
const SECRET = "ghp_valeur-tres-secrete-123";

describe("coffre d'identifiants", () => {
  it("créer : la valeur est chiffrée côté main, utilisable par l'agent ; la liste dit « hasValue » et ne contient JAMAIS la valeur", async () => {
    const { call, app } = await setupKernel();
    const list = (await call("vault-save", { name: "GITHUB_TOKEN", description: "Jeton GitHub" }, SECRET)) as View[];
    expect(list).toEqual([{ name: "GITHUB_TOKEN", description: "Jeton GitHub", envVar: "GITHUB_TOKEN", domains: [], allowShell: false, createdAt: expect.any(Number), hasValue: true }]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(await call("vault-list"))).not.toContain(SECRET);
    expect(app.agent.vault.hasValue("GITHUB_TOKEN")).toBe(true);
    expect(JSON.stringify(app.agent.settings.getAll())).not.toContain(SECRET); // pas dans les réglages en clair
  });

  it("modifier sans valeur GARDE la valeur ; une valeur vide aussi ; une nouvelle valeur la remplace", async () => {
    const { call, app } = await setupKernel();
    await call("vault-save", { name: "API", description: "v1" }, SECRET);
    await call("vault-save", { name: "API", description: "v2" });
    await call("vault-save", { name: "API", description: "v3" }, "");
    expect(app.agent.vault.hasValue("API")).toBe(true);
    expect(app.agent.settings.getSecret("vault:API")).toBe(SECRET);
    await call("vault-save", { name: "API", description: "v4" }, "autre");
    expect(app.agent.settings.getSecret("vault:API")).toBe("autre");
    expect(((await call("vault-list")) as View[])[0]!.description).toBe("v4");
  });

  it("ÉLARGIR demande une boîte native qui nomme les domaines et le shell ; refusée, rien n'est écrit (ni l'entrée ni la valeur)", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await rejects(() => call("vault-save", { name: "T", description: "", domains: ["api.github.com", "*.example.org"], allowShell: true }, SECRET), /refusé par l'utilisateur/);
    expect(app.agent.vault.list()).toEqual([]);
    expect(app.agent.vault.hasValue("T")).toBe(false);
    expect(confirms[0]!.message).toMatch(/dans les commandes du shell et vers de nouveaux domaines/);
    expect(confirms[0]!.detail).toContain("api.github.com, *.example.org");
    expect(confirms[0]!.detail).toMatch(/variable d'environnement/);
    expect(confirms[0]!.detail).not.toContain(SECRET);
    const ok = (await call("vault-save", { name: "T", domains: ["api.github.com"], allowShell: true }, SECRET)) as View[];
    expect(ok[0]).toMatchObject({ domains: ["api.github.com"], allowShell: true });
  });

  it("RESTREINDRE ne demande rien (retirer un domaine, couper le shell) ; ajouter un domaine à un secret existant redemande", async () => {
    const { call, confirms } = await setupKernel(undefined, [true, true]);
    await call("vault-save", { name: "T", domains: ["a.example.org", "b.example.org"], allowShell: true }, SECRET);
    expect(confirms).toHaveLength(1);
    await call("vault-save", { name: "T", domains: ["a.example.org"], allowShell: false });
    expect(confirms).toHaveLength(1);
    await call("vault-save", { name: "T", domains: ["a.example.org", "c.example.org"] });
    expect(confirms).toHaveLength(2);
    expect(confirms[1]!.detail).toContain("c.example.org");
    expect(confirms[1]!.detail).not.toContain("a.example.org");
  });

  it("supprimer : boîte native ; refusée, le secret reste ; acceptée, l'entrée ET la valeur disparaissent", async () => {
    const { call, app } = await setupKernel(undefined, [false, true]);
    await call("vault-save", { name: "T" }, SECRET);
    await rejects(() => call("vault-remove", "T"), /refusé par l'utilisateur/);
    expect(app.agent.vault.hasValue("T")).toBe(true);
    expect(await call("vault-remove", "T")).toEqual([]);
    expect(app.agent.vault.hasValue("T")).toBe(false);
    expect(app.agent.settings.getSecret("vault:T")).toBeUndefined();
    await rejects(() => call("vault-remove", "inconnu"), /secret inconnu/);
  });

  it("validation : nom, variable, domaines (schéma, chemin, port), types, nouveau secret sans valeur, champs inconnus — rien n'est écrit, la valeur n'apparaît dans aucune erreur", async () => {
    const { call, app } = await setupKernel(undefined, [true, true, true, true]);
    const bad: [unknown, unknown, RegExp][] = [
      [{ name: "1abc" }, SECRET, /nom invalide/],
      [{ name: "a b" }, SECRET, /nom invalide/],
      [{ name: "" }, SECRET, /nom invalide/],
      [{ name: "ok", envVar: "1X" }, SECRET, /variable d'environnement invalide/],
      [{ name: "ok", domains: ["https://exemple.org"] }, SECRET, /domaine invalide/],
      [{ name: "ok", domains: ["exemple.org/chemin"] }, SECRET, /domaine invalide/],
      [{ name: "ok", domains: ["exemple.org:8080"] }, SECRET, /domaine invalide/],
      [{ name: "ok", domains: ["10.0.0.1"] }, SECRET, /domaine invalide/],
      [{ name: "ok", domains: "exemple.org" }, SECRET, /liste attendue/],
      [{ name: "ok", domains: Array.from({ length: 21 }, (_, i) => `d${i}.example.org`) }, SECRET, /20 domaines/],
      [{ name: "ok", allowShell: "oui" }, SECRET, /booléen/],
      [{ name: "ok", description: "x".repeat(301) }, SECRET, /300 caractères/],
      [{ name: "ok", description: 5 }, SECRET, /texte attendu/],
      [{ name: "ok", virus: 1 }, SECRET, /inconnu/],
      [{ name: "ok" }, undefined, /besoin d'une valeur/],
      [{ name: "ok" }, 42, /texte de 20000/],
      [{ name: "ok" }, "x".repeat(20_001), /texte de 20000/],
      [null, SECRET, /entrée attendue/],
      [[], SECRET, /entrée attendue/],
    ];
    for (const [entry, value, why] of bad) {
      const err = await Promise.resolve().then(() => call("vault-save", entry, value)).then(() => null, (e: Error) => e);
      expect(err, JSON.stringify(entry)).toBeInstanceOf(Error);
      expect(err!.message, JSON.stringify(entry)).toMatch(why);
      expect(err!.message).not.toContain(SECRET);
    }
    expect(app.agent.vault.list()).toEqual([]);
  });

  it("le secret n'est jamais importable ni exposé par get-jarod-settings", async () => {
    const { call } = await setupKernel();
    await call("vault-save", { name: "T" }, SECRET);
    const snap = (await call("get-jarod-settings")) as Record<string, unknown>;
    expect(snap).not.toHaveProperty("vault");
    expect(JSON.stringify(snap)).not.toContain(SECRET);
    await rejects(() => call("set-jarod-settings", { vault: [] }), /non géré/);
  });
});
