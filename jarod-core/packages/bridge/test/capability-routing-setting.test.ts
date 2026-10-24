/**
 * V-19 — réglage `capabilityRouting` par le vrai handler : validation avant écriture, `null` retire une route, fournisseur inconnu
 * refusé ; une route vers un fournisseur qui sort de la machine et n'était pas nommé demande une confirmation native qui le NOMME
 * (refusée : rien n'est écrit) ; un fournisseur local passe sans question.
 */
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

type Routes = Record<string, { provider: string; model: string }>;

describe("V-19 — réglage capabilityRouting", () => {
  it("vide par défaut ; une route locale s'écrit sans question ; null la retire", async () => {
    const { call, confirms } = await setupKernel();
    expect(((await call("get-jarod-settings")) as { capabilityRouting: Routes }).capabilityRouting).toEqual({});
    const after = (await call("set-jarod-settings", { capabilityRouting: { code: { provider: "ollama", model: "qwen2.5-coder" } } })) as { capabilityRouting: Routes };
    expect(after.capabilityRouting).toEqual({ code: { provider: "ollama", model: "qwen2.5-coder" } });
    expect(confirms).toHaveLength(0);
    const cleared = (await call("set-jarod-settings", { capabilityRouting: { code: null } })) as { capabilityRouting: Routes };
    expect(cleared.capabilityRouting).toEqual({});
  }, 60_000);

  it("refus avant écriture : clé inconnue, modèle vide, fournisseur inconnu", async () => {
    const { call } = await setupKernel();
    for (const bad of [{ audio: { provider: "ollama", model: "x" } }, { code: { provider: "ollama", model: "" } }, { code: { provider: "nulle-part", model: "x" } }, { code: "ollama" }])
      await expect(Promise.resolve().then(() => call("set-jarod-settings", { capabilityRouting: bad }))).rejects.toThrow(/capabilityRouting|fournisseur/);
    expect(((await call("get-jarod-settings")) as { capabilityRouting: Routes }).capabilityRouting).toEqual({});
  }, 60_000);

  it("un fournisseur distant pas encore nommé : confirmation qui le nomme ; refusée, rien n'est écrit", async () => {
    const { call, confirms } = await setupKernel(undefined, [false]);
    await expect(Promise.resolve().then(() => call("set-jarod-settings", { capabilityRouting: { vision: { provider: "openai", model: "gpt-4o" } } }))).rejects.toThrow(/refusé/);
    expect(confirms).toHaveLength(1);
    expect(confirms[0]!.message).toMatch(/OpenAI/);
    expect(confirms[0]!.action).toBe("Autoriser la route");
    expect(((await call("get-jarod-settings")) as { capabilityRouting: Routes }).capabilityRouting).toEqual({});
  }, 60_000);
});
