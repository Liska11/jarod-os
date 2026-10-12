// Jarod-cordis (Q18) : état de travail par conversation — SANK-AI `kernel/session-state.js` (MIT), persistant ici.
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import { STATE_MAX_KEYS, STATE_MAX_VALUE_BYTES } from "../src/session-state.js";
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

function run(core: TestCore, sessionId: string, text: string) {
  return new Promise<AgentEvent[]>((resolve) => {
    const events: AgentEvent[] = [];
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

const toolResults = (core: TestCore, id: string) =>
  core.messages.list(id).filter((m) => m.role === "tool").map((m) => [m.toolName, m.content, m.isError ?? false]);

describe("état de travail par conversation (Q18)", () => {
  it("outils state_* : écrit, relit, liste, supprime — sans approbation, propre à la conversation", async () => {
    const core = await makeCore();
    const a = core.sessions.create();
    const b = core.sessions.create();
    fakeProvider(core, [
      {
        toolCalls: [
          { id: "1", name: "state_set", args: { key: "cible", value: "src/app.ts" } },
          { id: "2", name: "state_set", args: { key: "étapes", value: { faites: 2, reste: ["tests"] }, type: "json" } },
          { id: "3", name: "state_get", args: { key: "étapes" } },
          { id: "4", name: "state_list", args: {} },
          { id: "5", name: "state_delete", args: { key: "cible" } },
          { id: "6", name: "state_get", args: { key: "cible" } },
        ],
      },
      { text: "noté" },
    ]);
    await run(core, a.id, "retiens");
    expect(toolResults(core, a.id)).toEqual([
      ["state_set", "ok : state[cible] enregistré", false],
      ["state_set", "ok : state[étapes] enregistré", false],
      ["state_get", '{"faites":2,"reste":["tests"]}', false],
      ["state_list", '[{"key":"cible","type":"text","value":"src/app.ts"},{"key":"étapes","type":"json","value":{"faites":2,"reste":["tests"]}}]', false],
      ["state_delete", "ok : cible supprimé", false],
      ["state_get", "Aucune valeur pour cible.", false],
    ]);
    expect(core.state.list(b.id)).toEqual([]);
    for (const n of ["state_set", "state_get", "state_list", "state_delete"]) expect(core.tools.get(n)?.dangerous).toBeFalsy();
  });

  it("plafonds : 64 clés, 8 Ko par valeur, clé non vide ; remplacer une clé existante reste possible à plein", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    for (let i = 0; i < STATE_MAX_KEYS; i++) core.state.set(s.id, `k${i}`, i);
    expect(() => core.state.set(s.id, "de-trop", 1)).toThrow(/État plein \(64 clés\)/);
    core.state.set(s.id, "k0", "remplacée");
    expect(core.state.get(s.id, "k0")).toBe("remplacée");
    expect(() => core.state.set(s.id, "k1", "x".repeat(STATE_MAX_VALUE_BYTES))).toThrow(/trop grande/);
    expect(() => core.state.set(s.id, "  ", 1)).toThrow(/Clé invalide/);
  });

  it("le résumé entre au prompt système et y reste après la compaction (l'historique, lui, est résumé)", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [{}, {}, {}, { text: "résumé" }, {}]);
    core.state.set(s.id, "branche", "feat/q18");
    for (const t of ["un", "deux", "trois"]) await run(core, s.id, t);
    expect(reqs[0]!.system).toContain("# État de travail de la conversation");
    expect(reqs[0]!.system).toContain("- branche (text): feat/q18");
    await core.commands.execute("/compact", { sessionId: s.id });
    await run(core, s.id, "quatre");
    expect(reqs[4]!.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(reqs[4]!.messages)).toContain("résumé");
    expect(reqs[4]!.system).toContain("- branche (text): feat/q18");
    // Sans état : aucun bloc ajouté.
    const t = core.sessions.create();
    const r2 = fakeProvider(core, [{}]);
    await run(core, t.id, "x");
    expect(r2[0]!.system).not.toContain("État de travail");
  });

  it("un sous-agent lit l'état du parent mais ne l'écrit pas ; supprimer la conversation efface son état", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    core.state.set(s.id, "k", "v");
    const reqs = fakeProvider(core, [{ text: "compte rendu" }]);
    await core.agent.runSubAgent("explore", new AbortController().signal, s.id);
    const names = reqs[0]!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["state_get", "state_list"]));
    expect(names).not.toContain("state_set");
    expect(names).not.toContain("state_delete");
    core.sessions.delete(s.id);
    expect(core.state.list(s.id)).toEqual([]);
  });
});
