// V-19 — routage par capacité dans un VRAI tour d'agent : le fournisseur et le modèle qui reçoivent la requête, l'annonce du choix,
// la conversation épinglée jamais re-routée, et le repli vers le modèle actif quand la route ne répond pas.
import { type ChatRequest, type ChatResult, ProviderError, type ProviderClient } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import type { TestCore as JarodCore } from "./helpers.js";
import { makeCore } from "./helpers.js";

/** Chaque requête reçue, avec le fournisseur à qui elle a été adressée ; `failing` = fournisseurs qui répondent en erreur. */
function fakeProviders(core: JarodCore, failing: string[] = []): { provider: string; model: string }[] {
  const seen: { provider: string; model: string }[] = [];
  core.providers.client = ((provider: string) => {
    const client: ProviderClient = {
      listModels: async () => ["m"],
      chat: async (req: ChatRequest, h) => {
        seen.push({ provider, model: req.model });
        if (failing.includes(provider)) throw new ProviderError("503 indisponible", 503);
        const r: ChatResult = { text: "ok", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 10, outputTokens: 2 };
        h.onText?.(r.text);
        return r;
      },
    };
    return client;
  }) as never;
  core.settings.set("autoTitle", false);
  return seen;
}

function run(core: JarodCore, sessionId: string, text: string) {
  const events: AgentEvent[] = [];
  return new Promise<AgentEvent[]>((resolve) => {
    const hooks: AgentHooks = {
      emit: (e) => {
        events.push(e);
        if (e.type === "done") resolve(events);
      },
      approve: async () => true,
    };
    void core.submit(sessionId, text, hooks);
  });
}

const statuses = (events: AgentEvent[]) => events.filter((e) => e.type === "status").map((e) => (e as { status: string }).status);

describe("routage par capacité dans un tour (V-19)", () => {
  it("un message qui porte du code part au modèle de la route « code », annoncé ; un message ordinaire reste au modèle actif", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "anthropic", activeModel: "claude-x", capabilityRouting: { code: { provider: "ollama", model: "qwen2.5-coder" } } });
    const seen = fakeProviders(core);
    const s = core.sessions.create();

    const coded = await run(core, s.id, "Corrige ce bug :\n```ts\nconst a: number = 'x'\n```");
    expect(seen.at(-1)).toEqual({ provider: "ollama", model: "qwen2.5-coder" });
    expect(statuses(coded).join("\n")).toMatch(/Modèle pour code : ollama · qwen2\.5-coder/);

    const plain = await run(core, s.id, "Merci, et quelle heure est-il à Dakar ?");
    expect(seen.at(-1)).toEqual({ provider: "anthropic", model: "claude-x" });
    expect(statuses(plain).join("\n")).not.toMatch(/Modèle pour/);
  });

  it("une conversation au modèle épinglé n'est jamais re-routée", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "anthropic", activeModel: "claude-x", capabilityRouting: { code: { provider: "ollama", model: "qwen2.5-coder" } } });
    const seen = fakeProviders(core);
    const s = core.sessions.create();
    core.updateSessionContext(s.id, { provider: "anthropic", model: "claude-x", modelPinned: true });

    await run(core, s.id, "```py\nprint(1)\n```");
    expect(seen.at(-1)).toEqual({ provider: "anthropic", model: "claude-x" });
  });

  it("la route ne répond pas : le tour bascule sur le modèle actif, qui reste derrière elle", async () => {
    const core = await makeCore();
    core.settings.patch({ activeProvider: "anthropic", activeModel: "claude-x", capabilityRouting: { code: { provider: "ollama", model: "qwen2.5-coder" } } });
    const seen = fakeProviders(core, ["ollama"]);
    const s = core.sessions.create();

    await run(core, s.id, "Regarde src/main.rs, ça ne compile pas");
    expect(seen.map((x) => x.provider)).toEqual(["ollama", "anthropic"]);
  });
});
