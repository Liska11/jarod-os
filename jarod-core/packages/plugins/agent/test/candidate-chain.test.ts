// Portage de packages/core/test/candidate-chain.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { candidateChain } from "../src/agent.js";
import { RoutingService } from "@jarod/plugin-llm";

const base = { activeProvider: "anthropic", activeModel: "gros" };

describe("la chaîne de repli est déclarée, pas devinée", () => {
  it("une chaîne vide rend exactement ce qu'on avait avant : un seul candidat", () => {
    const chain = candidateChain({ ...base, fallbacks: [] }, new RoutingService());
    expect(chain).toEqual([{ provider: "anthropic", model: "gros" }]);
  });

  it("respecte l'ordre écrit par l'utilisateur, et reprend son modèle actif si aucun n'est nommé", () => {
    const chain = candidateChain(
      { ...base, fallbacks: [{ provider: "openai", model: "moyen" }, { provider: "local" }] },
      new RoutingService(),
    );
    expect(chain).toEqual([
      { provider: "anthropic", model: "gros" },
      { provider: "openai", model: "moyen" },
      { provider: "local", model: "gros" },
    ]);
  });

  it("un candidat en panne passe derrière, mais ne disparaît pas", () => {
    const routing = new RoutingService();
    const fallbacks = [{ provider: "openai", model: "moyen" }];
    for (let i = 0; i < 3; i += 1) routing.record({ provider: "anthropic", model: "gros" }, { ok: false });
    const chain = candidateChain({ ...base, fallbacks }, routing);
    expect(chain.map((c) => c.provider)).toEqual(["openai", "anthropic"]);
  });

  it("aucun candidat sans nom : un repli vide ne bascule nulle part", () => {
    const chain = candidateChain({ ...base, fallbacks: [{ provider: "" }] }, new RoutingService());
    expect(chain).toHaveLength(1);
  });
});
