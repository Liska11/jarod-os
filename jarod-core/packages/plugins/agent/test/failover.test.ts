// Portage de packages/core/test/failover.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.js";
import { FailoverPlan } from "../src/agent.js";
import { extraKeyFor, secretKeyFor } from "@jarod/plugin-llm";
import { failoverKind, ProviderError } from "@jarod/contracts";
import { makeCore } from "./helpers.js";

type Core = Awaited<ReturnType<typeof makeCore>>;

/** A fake provider per (provider, key): each call is recorded, `fail` decides who errs. */
function fakes(core: Core, fail: (provider: string, keyIndex: number) => Error | null) {
  const calls: { provider: string; keyIndex: number; model: string; maxAttempts?: number }[] = [];
  core.providers.client = (provider: string, keyIndex = 0) =>
    ({
      chat: async (req: { model: string; maxAttempts?: number }) => {
        calls.push({
          provider,
          keyIndex,
          model: req.model,
          ...(req.maxAttempts ? { maxAttempts: req.maxAttempts } : {}),
        });
        const err = fail(provider, keyIndex);
        if (err) throw err;
        return { text: `réponse de ${provider}#${keyIndex}`, thinking: "", toolCalls: [], stopReason: "stop" };
      },
      listModels: async () => [],
    }) as never;
  core.settings.set("autoTitle", false);
  return calls;
}

async function turn(core: Core, text = "salut") {
  const session = core.sessions.create();
  const events: AgentEvent[] = [];
  const r = await core.runAndWait(session.id, text, { emit: (e) => events.push(e), approve: async () => false });
  const assistant = core.messages.list(session.id).filter((m) => m.role === "assistant");
  return { r, events, assistant, statuses: events.flatMap((e) => (e.type === "status" ? [e.status] : [])) };
}

describe("ce qu'une erreur dit de la suite", () => {
  it("clé refusée ou limitée → une autre clé ; panne → un autre fournisseur ; requête fautive → rien", () => {
    expect(failoverKind(new ProviderError("HTTP 429", 429))).toBe("key");
    expect(failoverKind(new ProviderError("HTTP 401", 401))).toBe("key");
    expect(failoverKind(new ProviderError("HTTP 503", 503))).toBe("provider");
    expect(failoverKind(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(
      "provider",
    );
    expect(failoverKind(new ProviderError("HTTP 400: bad request", 400))).toBeNull();
    expect(failoverKind(new Error("outil inconnu"))).toBeNull();
  });

  it("le plan essaie chaque clé puis chaque fournisseur, une seule fois", () => {
    const plan = new FailoverPlan(
      [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
      ],
      (p) => (p === "a" ? [1, 0] : [0]),
    );
    expect(plan.current).toEqual({ provider: "a", model: "m1", keyIndex: 1 });
    expect(plan.next("key")).toBe(true);
    expect(plan.current.keyIndex).toBe(0);
    expect(plan.next("key")).toBe(true);
    expect(plan.current).toEqual({ provider: "b", model: "m2", keyIndex: 0 });
    expect(plan.hasNext()).toBe(false);
    expect(plan.next("provider")).toBe(false);
  });
});

describe("bascule en plein tour", () => {
  it("un 429 du fournisseur actif passe la main au repli déclaré, et le tour aboutit", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "openai", activeModel: "gpt-x" });
    core.settings.set("fallbacks", [{ provider: "mistral", model: "mistral-large" }]);
    const calls = fakes(core, (p) => (p === "openai" ? new ProviderError("HTTP 429: rate limit", 429) : null));
    const { r, assistant, statuses } = await turn(core);
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("réponse de mistral#0");
    expect(assistant.map((m) => [m.provider, m.model])).toEqual([["mistral", "mistral-large"]]);
    expect(
      statuses.some((s) => /OpenAI · gpt-x indisponible \(HTTP 429.*bascule sur Mistral · mistral-large/.test(s)),
    ).toBe(true);
    // A fallback was ready: the first call did not wait through four retries.
    expect(calls[0]).toMatchObject({ provider: "openai", maxAttempts: 2 });
    expect(calls[1]).toMatchObject({ provider: "mistral", model: "mistral-large" });
    expect(calls[1]!.maxAttempts).toBeUndefined();
  });

  it("une clé limitée cède la place à la suivante du même fournisseur, qui reste la préférée", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "openai", activeModel: "gpt-x" });
    core.settings.setSecret(secretKeyFor("openai"), "sk-principale");
    core.providers.setExtraKeys("openai", ["sk-deux"]);
    expect(core.providers.apiKeys("openai")).toEqual(["sk-principale", "sk-deux"]);
    expect(core.settings.getSecret(extraKeyFor("openai", 2))).toBe("sk-deux");
    const calls = fakes(core, (_p, k) => (k === 0 ? new ProviderError("HTTP 429", 429) : null));

    const first = await turn(core);
    expect(first.r.text).toBe("réponse de openai#1");
    expect(first.statuses.some((s) => /autre clé API/.test(s))).toBe(true);
    // The next turn starts with the key that answered, instead of hitting the limited one again.
    calls.length = 0;
    const second = await turn(core);
    expect(second.r.text).toBe("réponse de openai#1");
    expect(calls.map((c) => c.keyIndex)).toEqual([1]);
  });

  it("une panne sans repli reste une erreur, et une requête fautive ne bascule pas", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "openai", activeModel: "gpt-x" });
    fakes(core, () => new ProviderError("HTTP 503", 503));
    expect((await turn(core)).r.error).toMatch(/503/);

    const other = await makeCore();
    other.settings.patch({ activeProvider: "openai", activeModel: "gpt-x" });
    other.settings.set("fallbacks", [{ provider: "mistral", model: "m" }]);
    const calls = fakes(other, (p) => (p === "openai" ? new ProviderError("HTTP 400: contexte invalide", 400) : null));
    expect((await turn(other)).r.error).toMatch(/400/);
    expect(calls.map((c) => c.provider)).toEqual(["openai"]);
  });

  it("un candidat sans clé est sauté comme un candidat qui ne répond pas", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "openai", activeModel: "gpt-x" });
    core.settings.set("fallbacks", [{ provider: "mistral", model: "m" }]);
    const real = core.providers.client.bind(core.providers);
    const calls = fakes(core, () => null);
    const fake = core.providers.client;
    core.providers.client = (id: string, k?: number) => (id === "openai" ? real(id, k) : fake(id, k));
    const { r } = await turn(core);
    expect(r.text).toBe("réponse de mistral#0");
    expect(calls.map((c) => c.provider)).toEqual(["mistral"]);
  });
});
