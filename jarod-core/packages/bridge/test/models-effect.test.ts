/**
 * SPECS-P5-UI-PARITE.md § 15.3 (ME1 à ME4) — l'EFFET de la chaîne de repli du volet « Modèles » : ce que le volet écrit par `set-jarod-settings` est la chaîne que l'agent SUIT.
 * VRAI noyau, VRAIS handlers (`send-message`, `set-jarod-settings`), confirmations natives simulées ; les fournisseurs sont simulés au niveau du CLIENT (aucun réseau, rien ne sort de la
 * machine). Barres figées dans la spec AVANT le code.
 */
import { ProviderError } from "@jarod/contracts";
import { cleanup } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { setupKernel } from "./ui-parite-helpers.js";

afterEach(cleanup);

/** Un noyau dont le fournisseur actif est `openai` (panne 503) ; les autres répondent « réponse de <fournisseur> ». */
async function kernel(confirms: boolean[] = [true, true]) {
  const k = await setupKernel(undefined, confirms);
  k.app.agent.settings.patch({ activeProvider: "openai", activeModel: "gpt-x", autoTitle: false } as never);
  const calls: string[] = [];
  const down = new Set(["openai"]);
  k.app.agent.providers.client = ((provider: string) => ({
    chat: async () => {
      calls.push(provider);
      if (down.has(provider)) throw new ProviderError(`HTTP 503 (${provider})`, 503);
      return { text: `réponse de ${provider}`, thinking: "", toolCalls: [], stopReason: "stop" };
    },
    listModels: async () => [],
  })) as never;
  const send = (runId: string) => k.call("send-message", "salut", undefined, undefined, [], [], undefined, runId) as Promise<{ response: string; sessionId: string }>;
  const answeredBy = (sessionId: string) => k.app.agent.messages.list(sessionId).filter((m) => m.role === "assistant").map((m) => [m.provider, m.model]);
  const fallbacks = () => k.app.agent.settings.get("fallbacks");
  return { ...k, calls, down, send, answeredBy, fallbacks };
}

describe("la chaîne écrite par le volet est celle que l'agent suit", () => {
  it("ME1 : le fournisseur actif échoue (503), le premier repli répond ; l'ordre essayé est celui de la chaîne", async () => {
    const t = await kernel();
    await t.call("set-jarod-settings", { fallbacks: [{ provider: "mistral", model: "mistral-large" }, { provider: "groq" }] });
    expect(t.fallbacks()).toEqual([{ provider: "mistral", model: "mistral-large" }, { provider: "groq" }]);
    t.down.add("mistral"); // le premier repli est en panne aussi : le second prend le relais, dans l'ordre déclaré
    const r = await t.send("run-1");
    expect(r.response).toBe("réponse de groq");
    expect(t.calls, "ordre : actif, puis la chaîne telle qu'écrite").toEqual(["openai", "mistral", "groq"]);
    expect(t.answeredBy(r.sessionId)).toEqual([["groq", "gpt-x"]]);
  });

  it("ME1 bis : un repli avec son modèle : la réponse porte ce modèle", async () => {
    const t = await kernel();
    await t.call("set-jarod-settings", { fallbacks: [{ provider: "mistral", model: "mistral-large" }] });
    const r = await t.send("run-1");
    expect(r.response).toBe("réponse de mistral");
    expect(t.answeredBy(r.sessionId)).toEqual([["mistral", "mistral-large"]]);
  });

  it("ME2 : sans chaîne, le même échec arrête le tour avec une erreur (rien ne bascule vers un fournisseur non nommé)", async () => {
    const t = await kernel();
    expect(t.fallbacks()).toEqual([]);
    await expect(t.send("run-1")).rejects.toThrow(/503|openai/);
    expect(t.calls).toEqual(["openai"]);
  });

  it("ME3 : un fournisseur RETIRÉ de la chaîne n'est plus essayé au tour SUIVANT", async () => {
    const t = await kernel();
    await t.call("set-jarod-settings", { fallbacks: [{ provider: "mistral", model: "m" }] });
    expect((await t.send("run-1")).response).toBe("réponse de mistral");
    t.calls.length = 0;
    await t.call("set-jarod-settings", { fallbacks: [] }); // le volet retire la ligne et enregistre
    await expect(t.send("run-2")).rejects.toThrow();
    expect(t.calls, "mistral n'est plus jamais essayé").toEqual(["openai"]);
  });

  it("ME4 : un fournisseur nommé deux fois (ou identique au modèle actif) est REFUSÉ avant toute écriture", async () => {
    const t = await kernel();
    await expect(Promise.resolve(t.call("set-jarod-settings", { fallbacks: [{ provider: "mistral", model: "m" }, { provider: "mistral", model: "m" }] }))).rejects.toThrow(/doublon/);
    await expect(Promise.resolve(t.call("set-jarod-settings", { fallbacks: [{ provider: "openai", model: "gpt-x" }] }))).rejects.toThrow(/doublon/);
    await expect(Promise.resolve(t.call("set-jarod-settings", { fallbacks: Array.from({ length: 6 }, (_, i) => ({ provider: "mistral", model: `m${i}` })) }))).rejects.toThrow(/au plus 5/);
    expect(t.fallbacks(), "rien n'est écrit").toEqual([]);
    expect(t.confirms, "aucune confirmation n'a été demandée pour un refus de validation").toHaveLength(0);
  });

  it("la confirmation native NOMME le fournisseur qui sort de la machine ; refusée, rien n'est écrit et le tour n'y bascule pas", async () => {
    const t = await kernel([false]);
    await expect(Promise.resolve(t.call("set-jarod-settings", { fallbacks: [{ provider: "mistral", model: "m" }] }))).rejects.toThrow(/refusé par l'utilisateur/);
    expect(t.confirms).toHaveLength(1);
    expect(t.confirms[0]!.message).toMatch(/Mistral/i);
    expect(t.fallbacks()).toEqual([]);
    await expect(t.send("run-1")).rejects.toThrow();
    expect(t.calls).toEqual(["openai"]);
  });
});
