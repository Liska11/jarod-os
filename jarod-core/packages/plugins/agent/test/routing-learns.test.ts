// Portage de packages/core/test/routing-learns.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { makeCore } from "./helpers.js";

const CIBLE = { provider: "anthropic", model: "claude-opus-5" };

function breakerOf(core: Awaited<ReturnType<typeof makeCore>>) {
  return core.routing.state().find((b) => b.key === "anthropic:claude-opus-5");
}

describe("le disjoncteur apprend des appels réels", () => {
  it("un échec réel est inscrit, et trois échecs écartent le candidat", async () => {
    const core = await makeCore();
    core.providers.client = () =>
      ({
        chat: async () => {
          throw new Error("fournisseur injoignable");
        },
      }) as never;

    for (let i = 0; i < 3; i += 1) {
      await expect(core.agent.complete("salut", new AbortController().signal)).rejects.toThrow(/injoignable/);
    }
    // Sans cet enregistrement, un fournisseur pouvait échouer toute la journée sans que sa
    // politique s'en aperçoive : la politique n'apprend que d'issues observées.
    expect(breakerOf(core)?.failures).toBe(3);
    expect(core.routing.isDown(CIBLE)).toBe(true);
  });

  it("un succès réel efface les échecs et mesure la latence", async () => {
    const core = await makeCore();
    core.providers.client = () => ({ chat: async () => ({ text: "bonjour", toolCalls: [] }) }) as never;

    await expect(core.agent.complete("salut", new AbortController().signal)).resolves.toBe("bonjour");
    const breaker = breakerOf(core);
    expect(breaker?.failures).toBe(0);
    // Une latence mesurée, jamais nulle : c'est elle qui classe, pas une fiche technique.
    expect(typeof breaker?.latencyMs).toBe("number");
    expect(breaker?.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("le repli appelle le modèle de SON fournisseur", () => {
  /** Chaque appel, avec le fournisseur qui l'a reçu et le modèle demandé. */
  function espion(core: Awaited<ReturnType<typeof makeCore>>) {
    const appels: { provider: string; model: string }[] = [];
    core.providers.client = (provider: string) =>
      ({
        chat: async (req: { model: string }) => {
          appels.push({ provider, model: req.model });
          return { text: "réponse du repli", toolCalls: [] };
        },
      }) as never;
    return appels;
  }

  /** Le fournisseur actif est écarté : c'est exactement le moment où le repli doit servir. */
  function actifEnPanne(core: Awaited<ReturnType<typeof makeCore>>) {
    core.settings.set("fallbacks", [{ provider: "openai", model: "gpt-repli" }]);
    for (let i = 0; i < 3; i += 1) core.routing.record(CIBLE, { ok: false });
  }

  it("une complétion part vers le repli avec le modèle déclaré pour lui", async () => {
    const core = await makeCore();
    const appels = espion(core);
    actifEnPanne(core);
    await core.agent.complete("salut", new AbortController().signal);
    // Avant : `{ provider: "openai", model: "claude-opus-5" }` — un modèle Claude envoyé à OpenAI.
    expect(appels).toEqual([{ provider: "openai", model: "gpt-repli" }]);
  });

  it("un tour de conversation aussi, et la réponse est inscrite au nom de qui l'a donnée", async () => {
    const core = await makeCore();
    const appels = espion(core);
    actifEnPanne(core);
    const session = core.sessions.create();
    await core.runAndWait(session.id, "salut", { emit: () => {}, approve: async () => false });
    expect(appels[0]).toEqual({ provider: "openai", model: "gpt-repli" });
    const reponse = core.messages.list(session.id).find((m) => m.role === "assistant");
    expect(reponse?.provider).toBe("openai");
    expect(reponse?.model).toBe("gpt-repli");
  });

  it("un sous-agent aussi", async () => {
    const core = await makeCore();
    const appels = espion(core);
    actifEnPanne(core);
    const session = core.sessions.create();
    await core.agent.runSubAgent("cherche", undefined, session.id);
    expect(appels).toEqual([{ provider: "openai", model: "gpt-repli" }]);
  });
});
