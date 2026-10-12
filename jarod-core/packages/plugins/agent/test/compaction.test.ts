// Jarod-cordis (Q18) : compaction complétée — consigne de préservation et outil `compact` du modèle
// (SANK-AI `src/core/runtime/plugins/context-compaction/index.js`, MIT), sur la compaction persistante de Jarod.
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import { makeCore, type TestCore } from "./helpers.js";

function fakeProvider(core: TestCore, steps: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r: ChatResult = { text: "ok", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1, ...steps.shift() };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

function run(core: TestCore, sessionId: string, text: string, approve = true) {
  const events: AgentEvent[] = [];
  const approvals: string[] = [];
  return new Promise<{ events: AgentEvent[]; approvals: string[] }>((resolve) => {
    const hooks: AgentHooks = {
      emit: (e) => {
        events.push(e);
        if (e.type === "done") resolve({ events, approvals });
      },
      approve: async (_s, call) => {
        approvals.push(call.name);
        return approve;
      },
    };
    void core.submit(sessionId, text, hooks);
  });
}

/** Trois échanges : assez pour qu'une compaction ait quelque chose à résumer. */
async function threeExchanges(core: TestCore, id: string) {
  for (const t of ["un", "deux", "trois"]) await run(core, id, t);
}

const lastUserText = (r: ChatRequest) => {
  const m = r.messages.at(-1)!;
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
};

describe("compaction (Q18)", () => {
  it("/compact <consigne> transmet ce qu'il faut préserver au résumé ; sans consigne, le prompt source est inchangé", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [{}, {}, {}, { text: "résumé A" }]);
    await threeExchanges(core, s.id);
    const r = await core.commands.execute("/compact les tests qui échouent", { sessionId: s.id });
    expect(r?.text).toContain("Contexte compacté");
    expect(lastUserText(reqs[3]!)).toContain("Consigne de l'utilisateur, à respecter en priorité : les tests qui échouent");
    expect(core.messages.history(s.id).find((m) => m.kind === "summary")?.content).toBe("résumé A");

    const t = core.sessions.create();
    const reqs2 = fakeProvider(core, [{}, {}, {}, { text: "résumé B" }]);
    await threeExchanges(core, t.id);
    await core.commands.execute("/compact", { sessionId: t.id });
    expect(lastUserText(reqs2[3]!)).not.toContain("Consigne de l'utilisateur");
  });

  it("outil `compact` du modèle : approbation demandée, historique résumé (originaux gardés), écran rechargé", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    fakeProvider(core, [
      {},
      {},
      { toolCalls: [{ id: "c1", name: "compact", args: { preserve: "le chemin du fichier" } }] },
      { text: "résumé du modèle" }, // l'appel de compaction lui-même
      { text: "Je continue." },
    ]);
    await run(core, s.id, "un");
    await run(core, s.id, "deux");
    const { events, approvals } = await run(core, s.id, "trois");
    expect(approvals).toEqual(["compact"]);
    const tool = core.messages.list(s.id).find((m) => m.role === "tool" && m.toolName === "compact")!;
    expect(tool.content).toContain("Contexte compacté");
    expect(events.some((e) => e.type === "history")).toBe(true);
    expect(core.messages.history(s.id).find((m) => m.kind === "summary")?.content).toBe("résumé du modèle");
    // Les originaux restent en base (marqués), seule la vue envoyée au modèle est résumée.
    expect(core.messages.list(s.id).filter((m) => m.role === "user" && m.content === "un")).toHaveLength(1);
  });

  it("refusée par l'utilisateur : rien n'est compacté", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    fakeProvider(core, [{}, {}, { toolCalls: [{ id: "c1", name: "compact", args: {} }] }, { text: "D'accord." }]);
    await run(core, s.id, "un");
    await run(core, s.id, "deux");
    const { events } = await run(core, s.id, "trois", false);
    expect(core.messages.history(s.id).some((m) => m.kind === "summary")).toBe(false);
    expect(events.some((e) => e.type === "history")).toBe(false);
  });

  it("déclaré à effet (approbation) et absent des outils d'un sous-agent", async () => {
    const core = await makeCore();
    expect(core.tools.get("compact")?.dangerous).toBe(true);
    const reqs = fakeProvider(core, [{ text: "compte rendu" }]);
    const s = core.sessions.create();
    await core.agent.runSubAgent("explore", new AbortController().signal, s.id);
    expect(reqs[0]!.tools.map((t) => t.name)).not.toContain("compact");
  });
});
