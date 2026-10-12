// Portage de packages/core/test/eventstore.test.ts:7-29,91-137,159-172 (rév. 2e180305) : les tests
// « tour d'agent » du journal, reportés en P0 (plugin-storage) faute d'agent.
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient, StreamHandlers } from "@jarod/contracts";
import { makeCore, type TestCore as JarodCore } from "./helpers.js";

/** Answers every completion with `reply`, streaming it: enough to drive one real agent turn. */
function fakeProvider(core: JarodCore, reply: string): void {
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (_req: ChatRequest, h: StreamHandlers): Promise<ChatResult> => {
      h.onText?.(reply);
      return { text: reply, thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1 };
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
}

function turn(core: JarodCore, sessionId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    void core.submit(sessionId, text, {
      emit: (event) => {
        if (event.type === "done") resolve();
      },
      approve: async () => true,
    });
  });
}

describe("EventStoreService — tours d'agent", () => {
  it("records a whole agent turn as a shadow of the conversation", async () => {
    const core = await makeCore();
    fakeProvider(core, "bonjour");
    const session = core.sessions.create("Test");
    await turn(core, session.id, "salut");

    const log = core.events.list({ stream: `session:${session.id}` });
    const types = log.map((e) => e.type);
    expect(types[0]).toBe("user-message");
    expect(log[0]?.data).toEqual({ text: "salut", attachments: 0 });
    expect(types).toContain("done");
    // the prompt and the streamed answer are both in the log
    const serialised = JSON.stringify(log);
    expect(serialised).toContain("salut");
    expect(serialised).toContain("bonjour");
  });

  it("reconstructs a whole turn from the log alone", async () => {
    const core = await makeCore();
    fakeProvider(core, "bonjour");
    const session = core.sessions.create("Test");
    await turn(core, session.id, "salut");

    // Reading nothing but the log: this is what makes replay and audit possible at all.
    const log = core.events.list({ stream: `session:${session.id}` });
    const prompt = log.find((event) => event.type === "user-message")?.data;
    const answer = log
      .filter((event) => event.type === "delta")
      .map((event) => (event.data as { text?: string }).text ?? "")
      .join("");

    expect(prompt).toEqual({ text: "salut", attachments: 0 });
    expect(answer).toBe("bonjour");
  });

  it("stays a shadow: the relational tables remain the source of truth", async () => {
    const core = await makeCore();
    fakeProvider(core, "bonjour");
    const session = core.sessions.create("Test");
    await turn(core, session.id, "salut");
    const before = core.messages.list(session.id).length;

    core.events.prune(0);

    expect(core.events.list({ stream: `session:${session.id}` })).toHaveLength(0);
    expect(core.messages.list(session.id)).toHaveLength(before);
  });

  it("forgets a conversation when it is deleted", async () => {
    const core = await makeCore();
    fakeProvider(core, "bonjour");
    const gone = core.sessions.create("Supprimée");
    const kept = core.sessions.create("Gardée");
    await turn(core, gone.id, "un secret");
    await turn(core, kept.id, "salut");

    core.sessions.delete(gone.id);

    expect(core.events.list({ stream: `session:${gone.id}` })).toHaveLength(0);
    expect(JSON.stringify(core.events.list({ limit: 10_000 }))).not.toContain("un secret");
    expect(core.events.list({ stream: `session:${kept.id}` }).length).toBeGreaterThan(0);
  });
});
