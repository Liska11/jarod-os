// V-19 — routage par capacité : détection du besoin du tour, priorité, conversation épinglée, chaîne avec la route en tête.
import { describe, expect, it } from "vitest";
import { chooseCapability, looksLikeCode, type TurnNeeds, withRoute } from "../src/capability-routing.js";

const needs = (over: Partial<TurnNeeds> = {}): TurnNeeds => ({ text: "Bonjour", hasImage: false, activeSeesImages: false, historyTokens: 100, activeWindow: 8000, ...over });
const routes = { vision: { provider: "lmstudio", model: "qwen2.5-vl" }, code: { provider: "ollama", model: "qwen2.5-coder" }, longContext: { provider: "openrouter", model: "gemini-long" } };

describe("routage par capacité (V-19)", () => {
  it("aucune route déclarée, ou aucun besoin : rien ne change", () => {
    expect(chooseCapability(needs({ hasImage: true }), undefined)).toBeNull();
    expect(chooseCapability(needs({ hasImage: true }), {})).toBeNull();
    expect(chooseCapability(needs(), routes)).toBeNull();
  });

  it("vision : seulement si une image est jointe ET que le modèle actif ne voit pas", () => {
    expect(chooseCapability(needs({ hasImage: true }), routes)).toMatchObject({ capability: "vision", route: routes.vision });
    expect(chooseCapability(needs({ hasImage: true, activeSeesImages: true }), routes)).toBeNull();
  });

  it("long contexte : au-delà de 80 % d'une fenêtre CONNUE", () => {
    expect(chooseCapability(needs({ historyTokens: 7000 }), routes)).toMatchObject({ capability: "longContext", route: routes.longContext });
    expect(chooseCapability(needs({ historyTokens: 6000 }), routes)).toBeNull();
    expect(chooseCapability(needs({ historyTokens: 999_999, activeWindow: 0 }), routes)).toBeNull();
  });

  it("code : des signes nets seulement ; priorité vision > long contexte > code", () => {
    expect(chooseCapability(needs({ text: "Corrige ce bug :\n```ts\nconst a = 1\n```" }), routes)).toMatchObject({ capability: "code" });
    expect(chooseCapability(needs({ text: "Regarde src/app/main.py" }), routes)?.capability).toBe("code");
    expect(chooseCapability(needs({ text: "Quelle est la capitale du Sénégal ?" }), routes)).toBeNull();
    expect(chooseCapability(needs({ text: "```x```", hasImage: true, historyTokens: 7000 }), routes)?.capability).toBe("vision");
    expect(chooseCapability(needs({ text: "```x```", historyTokens: 7000 }), routes)?.capability).toBe("longContext");
  });

  it("une conversation épinglée n'est jamais re-routée ; une route incomplète est ignorée", () => {
    expect(chooseCapability(needs({ hasImage: true }), routes, true)).toBeNull();
    expect(chooseCapability(needs({ hasImage: true }), { vision: { provider: "x", model: "" } })).toBeNull();
  });

  it("looksLikeCode : trace Node, trace Python, mots du métier", () => {
    expect(looksLikeCode("Error\n    at run (C:/app/x.js:10:5)")).toBe(true);
    expect(looksLikeCode("Traceback (most recent call last):")).toBe(true);
    expect(looksLikeCode("peux-tu refactoriser ça ? refactor")).toBe(true);
    expect(looksLikeCode("Planifie mes vacances")).toBe(false);
  });

  it("withRoute : la route passe en tête, sans doublon ; les replis restent derrière dans leur ordre", () => {
    const chain = [
      { provider: "anthropic", model: "a" },
      { provider: "ollama", model: "qwen2.5-coder" },
      { provider: "openai", model: "b" },
    ];
    expect(withRoute(chain, routes.code)).toEqual([routes.code, chain[0], chain[2]]);
  });
});
