/**
 * SPECS-P5-UI-PARITE.md §2 — `get-jarod-settings` / `set-jarod-settings` : liste blanche, validation AVANT écriture, confirmation
 * native pour ce qui accroît le pouvoir de l'agent, jamais de secret. VRAI kernel, VRAIS handlers.
 */
import { DEFAULT_SETTINGS } from "@jarod/contracts";
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

describe("réglages Agent", () => {
  it("la lecture rend les valeurs par défaut du DTO, et rien d'autre que la liste blanche", async () => {
    const { call } = await setupKernel();
    const v = (await call("get-jarod-settings")) as Record<string, unknown>;
    // La liste blanche exacte : une clé de plus (ou de moins) doit se voir ici.
    expect(Object.keys(v).sort()).toEqual(
      ["alwaysAllowTools", "android", "apiServer", "anthropicFallbacks", "autoApproveTools", "agentMode", "autoTitle", "browserPersistent", "browserVisible", "compactThreshold", "connectedBrowser", "desktop", "disabledSkills", "ecosystem", "fallbacks", "imageDescription", "learning", "maxAgentSteps", "memoryInject", "mobile", "permissionsRules", "phoneApprovals", "rag", "sessionBudget", "shellGuard", "terminalShell", "toolSearch", "voice"].sort(),
    );
    expect(v).toMatchObject({
      autoApproveTools: false,
      alwaysAllowTools: [],
      terminalShell: "",
      browserVisible: true,
      browserPersistent: false,
      phoneApprovals: false,
      agentMode: "build",
      maxAgentSteps: 25,
      compactThreshold: 240_000,
      memoryInject: true,
      autoTitle: true,
      anthropicFallbacks: true,
      toolSearch: "auto",
      sessionBudget: { maxTokens: 0, maxCostUsd: 0 },
      learning: { enabled: true, reviewEvery: 8 },
      fallbacks: [],
      imageDescription: { mode: "auto", provider: "", model: "" },
    });
    // Aucun champ sensible ni hors liste n'est exposé (ni le dossier de travail, ni les surcharges réseau, ni le coffre, ni la persona, ni les appareils appairés).
    for (const k of ["workspace", "providerOverrides", "mcpServers", "vault", "persona", "sshHosts", "pluginTrust", "disabledPlugins"]) expect(v).not.toHaveProperty(k);
    expect(v.mobile).toEqual({ port: 10492 }); // jamais les appareils ni leurs jetons
    expect(v.android).toEqual({ timeoutMs: 15000 }); // jamais le chemin d'adb
  });

  it("écrit chaque réglage et le relit depuis la base", async () => {
    const { call, app } = await setupKernel();
    const after = (await call("set-jarod-settings", {
      agentMode: "plan",
      maxAgentSteps: 60,
      compactThreshold: 0,
      memoryInject: false,
      autoTitle: false,
      anthropicFallbacks: false,
      toolSearch: "off",
      sessionBudget: { maxTokens: 500_000, maxCostUsd: 2.5 },
      learning: { enabled: false, reviewEvery: 20 },
    })) as Record<string, unknown>;
    expect(after).toMatchObject({ agentMode: "plan", maxAgentSteps: 60, compactThreshold: 0, toolSearch: "off", sessionBudget: { maxTokens: 500_000, maxCostUsd: 2.5 }, learning: { enabled: false, reviewEvery: 20 } });
    const s = app.agent.settings.getAll();
    expect([s.agentMode, s.maxAgentSteps, s.compactThreshold, s.memoryInject, s.autoTitle, s.anthropicFallbacks, s.toolSearch]).toEqual(["plan", 60, 0, false, false, false, "off"]);
    expect(s.sessionBudget).toMatchObject({ maxTokens: 500_000, maxCostUsd: 2.5 });
    expect(s.learning).toEqual({ enabled: false, reviewEvery: 20 });
  });

  it("disabledSkills (DS5, SPECS-P5-DISABLED-SKILLS) : écriture large bornée, triée, sans doublon", async () => {
    const { call, app } = await setupKernel();
    const after = (await call("set-jarod-settings", { disabledSkills: ["skill-b", " skill-a ", "skill-b"] })) as Record<string, unknown>;
    expect(after.disabledSkills).toEqual(["skill-b", "skill-a"]); // Set + trim, ordre du payload
    expect(app.agent.settings.get("disabledSkills")).toEqual(["skill-b", "skill-a"]);
    // Réactivation : la liste est réécrite en entier (retour à vide).
    const cleared = (await call("set-jarod-settings", { disabledSkills: [] })) as Record<string, unknown>;
    expect(cleared.disabledSkills).toEqual([]);
    // Refus : pas une liste, id vide, id trop long, trop d'ids — RIEN n'est écrit.
    const before = app.agent.settings.get("disabledSkills");
    for (const bad of [[123], [""], ["a".repeat(201)], 3, null, Array(1001).fill("s")]) {
      await expect(Promise.resolve().then(() => call("set-jarod-settings", { disabledSkills: bad }))).rejects.toThrow(/disabledSkills/);
    }
    expect(app.agent.settings.get("disabledSkills")).toEqual(before);
  });

  it("un objet imbriqué se FUSIONNE : un champ seul garde les autres, et les plafonds par conversation (/budget) sont préservés", async () => {
    const { call, app } = await setupKernel();
    app.agent.settings.set("sessionBudget", { maxTokens: 1000, maxCostUsd: 1, perSession: { "conv-1": { maxTokens: 9, maxCostUsd: 0 } } });
    await call("set-jarod-settings", { sessionBudget: { maxCostUsd: 3 } });
    expect(app.agent.settings.get("sessionBudget")).toEqual({ maxTokens: 1000, maxCostUsd: 3, perSession: { "conv-1": { maxTokens: 9, maxCostUsd: 0 } } });
    await call("set-jarod-settings", { learning: { reviewEvery: 4 } });
    expect(app.agent.settings.get("learning")).toEqual({ enabled: true, reviewEvery: 4 });
  });

  it("valeur hors bornes, mauvais type ou clé inconnue : refus explicite, et RIEN n'est écrit (même les clés valides du même patch)", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.getAll();
    const refused: [Record<string, unknown>, RegExp][] = [
      [{ maxAgentSteps: 0 }, /maxAgentSteps.*entre/],
      [{ maxAgentSteps: 501 }, /entre/],
      [{ maxAgentSteps: 2.5 }, /entier/],
      [{ maxAgentSteps: "30" }, /entier/],
      [{ compactThreshold: 500 }, /entre 0 \(désactivé\) ou/],
      [{ agentMode: "dieu" }, /parmi build, plan/],
      [{ toolSearch: true }, /parmi/],
      [{ memoryInject: "oui" }, /booléen/],
      [{ sessionBudget: { maxTokens: -1 } }, /entre/],
      [{ sessionBudget: { maxCostUsd: Number.NaN } }, /montant/],
      [{ sessionBudget: { perSession: {} } }, /inconnue/],
      [{ learning: { reviewEvery: 0 } }, /entre/],
      [{ learning: { enabled: "x" } }, /booléen/],
      [{ learning: [] }, /objet/],
      [{ workspace: "C:\\" }, /non géré/],
      [{ providerOverrides: {} }, /non géré/],
      [{ vault: [] }, /non géré/],
      [{ __proto__x: 1, shellGuard: {} }, /non géré/],
    ];
    for (const [patch, why] of refused) {
      await expect(Promise.resolve().then(() => call("set-jarod-settings", { agentMode: "plan", ...patch }))).rejects.toThrow(why);
    }
    expect(app.agent.settings.getAll()).toEqual(before); // `agentMode: "plan"` valide, mais jamais écrit
    for (const bad of [null, [], "x", 3]) await expect(Promise.resolve().then(() => call("set-jarod-settings", bad))).rejects.toThrow(/objet/);
  });
});

describe("autoApproveTools : confirmation native", () => {
  it("l'activer demande une boîte native, « Annuler » par défaut ; refusée : réglage inchangé et erreur claire", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false]);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { autoApproveTools: true }))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(app.agent.settings.get("autoApproveTools")).toBe(false);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.message).toMatch(/sans demander/i);
    expect(confirms[0]!.detail).toMatch(/garde du shell/);
  });

  it("acceptée : écrit ; la boîte n'est PAS rouverte si c'est déjà activé, ni pour le retirer", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [true]);
    expect(((await call("set-jarod-settings", { autoApproveTools: true })) as { autoApproveTools: boolean }).autoApproveTools).toBe(true);
    expect(app.agent.settings.get("autoApproveTools")).toBe(true);
    await call("set-jarod-settings", { autoApproveTools: true });
    await call("set-jarod-settings", { autoApproveTools: false });
    expect(app.agent.settings.get("autoApproveTools")).toBe(false);
    expect(confirms).toHaveLength(1);
  });

  it("une confirmation refusée n'écrit PAS les autres réglages du même patch", async () => {
    const { call, app } = await setupKernel(undefined, [false]);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { maxAgentSteps: 99, autoApproveTools: true }))).rejects.toThrow(/refusé/);
    expect(app.agent.settings.get("maxAgentSteps")).toBe(DEFAULT_SETTINGS.maxAgentSteps);
  });
});

describe("réglages Modèles : chaîne de repli et description d'images", () => {
  it("get-jarod-options : fournisseurs du catalogue, locaux distingués, aucune clé", async () => {
    const { call } = await setupKernel();
    const o = (await call("get-jarod-options")) as { providers: { id: string; local: boolean; configured: boolean; models: string[] }[] };
    const ids = o.providers.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai", "ollama"]));
    expect(o.providers.find((p) => p.id === "ollama")!.local).toBe(true);
    expect(o.providers.find((p) => p.id === "anthropic")!.local).toBe(false);
    expect(JSON.stringify(o)).not.toMatch(/apiKey|secret|sk-/i);
  });

  it("repli local : écrit sans boîte ; repli hors machine : confirmation qui NOMME le fournisseur, refus = rien d'écrit", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await call("set-jarod-settings", { fallbacks: [{ provider: "ollama", model: "llama3" }] });
    expect(app.agent.settings.get("fallbacks")).toEqual([{ provider: "ollama", model: "llama3" }]);
    expect(confirms).toHaveLength(0);

    await expect(Promise.resolve().then(() => call("set-jarod-settings", { fallbacks: [{ provider: "ollama", model: "llama3" }, { provider: "openai" }] }))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.message).toMatch(/OpenAI/);
    expect(confirms[0]!.detail).toMatch(/hors de cette machine/);
    expect(app.agent.settings.get("fallbacks")).toEqual([{ provider: "ollama", model: "llama3" }]);

    await call("set-jarod-settings", { fallbacks: [{ provider: "ollama", model: "llama3" }, { provider: "openai" }] });
    expect(app.agent.settings.get("fallbacks")).toEqual([{ provider: "ollama", model: "llama3" }, { provider: "openai" }]);
    // Retirer un fournisseur, ou réécrire la même chaîne, ne redemande rien.
    await call("set-jarod-settings", { fallbacks: [{ provider: "openai" }] });
    expect(confirms).toHaveLength(2);
  });

  it("repli : fournisseur inconnu, doublon, identique à l'actif, trop long, type invalide — refus, rien d'écrit", async () => {
    const { call, app } = await setupKernel();
    const active = app.agent.settings.get("activeProvider");
    const bad: [unknown, RegExp][] = [
      [[{ provider: "inconnu" }], /fournisseur inconnu/],
      [[{ provider: "ollama" }, { provider: "ollama" }], /doublon/],
      [[{ provider: active }], /doublon \(ou identique au modèle actif\)/],
      [[{ provider: "ollama", model: "a" }, { provider: "ollama", model: "b" }, { provider: "lmstudio", model: "c" }, { provider: "llamacpp", model: "d" }, { provider: "ollama", model: "e" }, { provider: "ollama", model: "f" }], /au plus 5/],
      [[{ provider: "" }], /vide/],
      [[{ provider: "ollama", extra: 1 }], /inconnue/],
      [[{ provider: "ollama", model: 3 }], /texte/],
      ["ollama", /liste/],
    ];
    for (const [v, why] of bad) await expect(Promise.resolve().then(() => call("set-jarod-settings", { fallbacks: v }))).rejects.toThrow(why);
    expect(app.agent.settings.get("fallbacks")).toEqual([]);
  });

  it("description d'images : mode et fournisseur local sans boîte ; fournisseur distant confirmé ; modèle sans fournisseur refusé", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await call("set-jarod-settings", { imageDescription: { mode: "always", provider: "ollama", model: "llava" } });
    expect(app.agent.settings.get("imageDescription")).toEqual({ mode: "always", provider: "ollama", model: "llava" });
    expect(confirms).toHaveLength(0);

    await expect(Promise.resolve().then(() => call("set-jarod-settings", { imageDescription: { provider: "openai", model: "gpt-4o" } }))).rejects.toThrow(/refusé/);
    expect(confirms[0]!.message).toMatch(/images à OpenAI/);
    expect(app.agent.settings.get("imageDescription").provider).toBe("ollama");
    await call("set-jarod-settings", { imageDescription: { provider: "openai", model: "gpt-4o" } });
    expect(app.agent.settings.get("imageDescription")).toEqual({ mode: "always", provider: "openai", model: "gpt-4o" });

    // Désactivé : rien ne part, pas de boîte. Fournisseur vidé : le modèle est vidé avec lui.
    await call("set-jarod-settings", { imageDescription: { mode: "off", provider: "" } });
    expect(app.agent.settings.get("imageDescription")).toEqual({ mode: "off", provider: "", model: "" });
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { imageDescription: { model: "x" } }))).rejects.toThrow(/exige un fournisseur/);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { imageDescription: { mode: "souvent" } }))).rejects.toThrow(/auto, always, off/);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { imageDescription: { provider: "inconnu" } }))).rejects.toThrow(/fournisseur inconnu/);
  });
});

describe("permissionsRules (AV2-008) : règles de l'utilisateur, relues à chaud par le garde", () => {
  it("écrit les règles et le portail DÉJÀ distribué à l'agent suit, sans redémarrage ; durcir ne demande aucune boîte", async () => {
    const { call, app, confirms } = await setupKernel();
    expect(app.agent.gate!.decide("run_shell")).toBe("allow"); // déclaré au registre, aucune règle
    const after = (await call("set-jarod-settings", { permissionsRules: [{ tool: "run_shell", decision: "deny" }] })) as Record<string, unknown>;
    expect(after.permissionsRules).toEqual([{ tool: "run_shell", decision: "deny" }]);
    expect(app.agent.settings.get("permissionsRules")).toEqual([{ tool: "run_shell", decision: "deny" }]);
    expect(app.agent.gate!.decide("run_shell")).toBe("deny");
    expect(app.agent.gate!.decide("read_file")).toBe("allow");
    expect(confirms).toHaveLength(0); // lever un refus ne demande rien : durcir n'a jamais besoin de boîte
  });

  it("AFFAIBLIR (retirer un refus) exige la confirmation native qui liste le changement ; refusée : rien n'est écrit", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await call("set-jarod-settings", { permissionsRules: [{ tool: "run_shell", decision: "deny" }] });
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { permissionsRules: [] }))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(app.agent.settings.get("permissionsRules")).toEqual([{ tool: "run_shell", decision: "deny" }]);
    expect(app.agent.gate!.decide("run_shell")).toBe("deny");
    expect(confirms[0]!.message).toMatch(/Affaiblir le garde de permissions/);
    expect(confirms[0]!.detail).toMatch(/« deny » devient « allow »/);

    await call("set-jarod-settings", { permissionsRules: [] });
    expect(app.agent.settings.get("permissionsRules")).toEqual([]);
    expect(app.agent.gate!.decide("run_shell")).toBe("allow");
    // Réécrire la même politique, ou n'ajouter qu'un refus, ne redemande rien.
    await call("set-jarod-settings", { permissionsRules: [{ tool: "fs", decision: "deny" }] });
    expect(confirms).toHaveLength(2);
  });

  it("validation AVANT écriture : forme Zod, caractères du nom, doublons, plafond — rien n'est écrit", async () => {
    const { call, app } = await setupKernel();
    const before = app.agent.settings.get("permissionsRules");
    const refused: [unknown, RegExp][] = [
      ["run_shell", /liste de règles/],
      [[{ tool: "a" }], /permissionsRules\[0\]/],
      [[{ tool: "a", decision: "peut-être" }], /permissionsRules\[0\]/],
      [[{ tool: "", decision: "allow" }], /permissionsRules\[0\]/],
      [[{ tool: "a b", decision: "allow" }], /permissionsRules\[0\]\.tool/],
      [[{ tool: "a".repeat(65), decision: "allow" }], /permissionsRules\[0\]\.tool/],
      [[{ tool: "a", decision: "allow", extra: 1 }], /inconnue/],
      [[{ tool: "a", decision: "allow" }, { tool: "a", decision: "deny" }], /en double/],
      [Array.from({ length: 201 }, (_v, i) => ({ tool: `outil${i}`, decision: "allow" })), /au plus 200/],
    ];
    for (const [v, why] of refused) {
      await expect(Promise.resolve().then(() => call("set-jarod-settings", { permissionsRules: v }))).rejects.toThrow(why);
    }
    expect(app.agent.settings.get("permissionsRules")).toEqual(before);
    expect(app.agent.gate!.decide("a")).toBe("deny"); // aucune règle n'a été écrite au passage
  });

  it("l'ORDRE est la sémantique : la première règle qui couvre l'outil gagne, et le joker couvre le reste", async () => {
    const { call, app } = await setupKernel(undefined, [true]);
    await call("set-jarod-settings", { permissionsRules: [{ tool: "fs", decision: "deny" }, { tool: "fs_read", decision: "allow" }] });
    expect(app.agent.settings.get("permissionsRules")).toEqual([{ tool: "fs", decision: "deny" }, { tool: "fs_read", decision: "allow" }]);
    // `match` teste `_`/`/` équivalents et le SEGMENT : `fs` couvre `fs_write`, mais la règle exacte placée avant gagne.
    expect(app.agent.gate!.decide("fs_write")).toBe("deny");
    expect(app.agent.gate!.decide("fs_read")).toBe("deny"); // `fs` est AVANT `fs_read` : l'ordre est la sémantique
    expect((await call("get-jarod-settings") as Record<string, unknown>).permissionsRules).toEqual([{ tool: "fs", decision: "deny" }, { tool: "fs_read", decision: "allow" }]);
  });
});

describe("alwaysAllowTools : l'écran ne fait que retirer", () => {
  it("retirer un outil de la liste ; en AJOUTER un par ce canal est refusé (il n'entre que par la fenêtre d'accord)", async () => {
    const { call, app } = await setupKernel();
    app.agent.settings.set("alwaysAllowTools", ["write_file", "edit_file"]);
    expect(((await call("get-jarod-settings")) as { alwaysAllowTools: string[] }).alwaysAllowTools).toEqual(["write_file", "edit_file"]);
    await call("set-jarod-settings", { alwaysAllowTools: ["edit_file"] });
    expect(app.agent.settings.get("alwaysAllowTools")).toEqual(["edit_file"]);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { alwaysAllowTools: ["edit_file", "run_shell"] }))).rejects.toThrow(/ajout refusé ici \(run_shell\)/);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { alwaysAllowTools: [3] }))).rejects.toThrow(/liste de noms/);
    expect(app.agent.settings.get("alwaysAllowTools")).toEqual(["edit_file"]);
    await call("set-jarod-settings", { alwaysAllowTools: [] });
    expect(app.agent.settings.get("alwaysAllowTools")).toEqual([]);
  });
});

describe("accords sur le téléphone", () => {
  it("off by default; turning it on asks natively (refused = nothing written); turning it off asks nothing", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    expect(app.agent.settings.get("phoneApprovals")).toBe(false);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { phoneApprovals: true }))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(confirms[0]!.message).toMatch(/téléphone/);
    expect(app.agent.settings.get("phoneApprovals")).toBe(false);
    await call("set-jarod-settings", { phoneApprovals: true });
    expect(app.agent.settings.get("phoneApprovals")).toBe(true);
    await call("set-jarod-settings", { phoneApprovals: false });
    expect(app.agent.settings.get("phoneApprovals")).toBe(false);
    expect(confirms).toHaveLength(2);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { phoneApprovals: "oui" }))).rejects.toThrow(/booléen/);
  });
});

describe("navigateur de l'agent : session persistante et oubli", () => {
  it("garder les connexions : confirmation native qui le dit (refusée = rien d'écrit) ; la retirer ne demande rien", async () => {
    const { call, app, confirms } = await setupKernel(undefined, [false, true]);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { browserPersistent: true }))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(confirms[0]!.message).toMatch(/Garder les connexions/);
    expect(confirms[0]!.detail).toMatch(/propre à l'agent/);
    expect(app.agent.settings.get("browserPersistent")).toBe(false);
    await call("set-jarod-settings", { browserPersistent: true });
    expect(app.agent.settings.get("browserPersistent")).toBe(true);
    await call("set-jarod-settings", { browserPersistent: false });
    expect(app.agent.settings.get("browserPersistent")).toBe(false);
    expect(confirms).toHaveLength(2);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { browserPersistent: "oui" }))).rejects.toThrow(/booléen/);
  });

  it("agent-browser-forget : boîte native « Annuler » par défaut ; refusée, rien n'est effacé ; sans navigateur (mode sans fenêtre) : erreur claire", async () => {
    let forgotten = 0;
    const k = await setupKernel(undefined, [false, true], { agentBrowser: { forget: async () => void forgotten++ } });
    expect(await k.call("agent-browser-forget")).toBe(false);
    expect(forgotten).toBe(0);
    expect(k.confirms[0]!.message).toMatch(/Oublier le navigateur de l'agent/);
    expect(k.confirms[0]!.detail).toMatch(/Vos propres navigateurs ne sont pas touchés/);
    expect(await k.call("agent-browser-forget")).toBe(true);
    expect(forgotten).toBe(1);
    const none = await setupKernel(undefined, [true]);
    await expect(Promise.resolve().then(() => none.call("agent-browser-forget"))).rejects.toThrow(/indisponible/);
  });
});
