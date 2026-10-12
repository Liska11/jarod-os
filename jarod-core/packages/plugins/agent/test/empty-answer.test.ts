// Réponse finale BLANCHE : constaté le 2026-10-01 avec le vrai modèle local (Defiant-Fable-9B) — après un appel d'outil réussi (rag_index) le
// modèle ne rend que quelques mots de raisonnement et AUCUN texte ; la fenêtre affichait une bulle vide et l'utilisateur croyait à un échec.
// Règle : quand le modèle termine un tour sans texte (et sans appel d'outil), l'agent écrit un message de repli HONNÊTE (le modèle n'a rien
// rédigé + le dernier outil et son résultat), au lieu d'une bulle vide. Un tour qui a du texte, ou une étape intermédiaire avec outils, ne change pas.
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import type { TestCore as JarodCore } from "./helpers.js";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import { makeCore, tempDir } from "./helpers.js";

function fakeProvider(core: JarodCore, steps: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r: ChatResult = { text: "", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 10, outputTokens: 5, ...(steps.shift() ?? {}) };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
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

const lastAssistant = (core: JarodCore, id: string) => core.messages.list(id).filter((m) => m.role === "assistant").at(-1)!;
const deltas = (events: AgentEvent[]) => events.filter((e) => e.type === "delta").map((e) => (e as { text?: string }).text ?? "").join("");

describe("réponse finale blanche", () => {
  it("après un outil réussi : message de repli qui dit que le modèle n'a rien rédigé, nomme l'outil et rend son résultat ; le texte est aussi diffusé", async () => {
    const core = await makeCore();
    core.settings.set("workspace", tempDir());
    const s = core.sessions.create();
    fakeProvider(core, [
      { toolCalls: [{ id: "t1", name: "write_file", args: { path: "hello.txt", content: "coucou" } }] },
      { text: "", thinking: "ok" },
    ]);
    const events = await run(core, s.id, "crée hello.txt");
    const last = lastAssistant(core, s.id);
    expect(last.content.trim()).not.toBe("");
    expect(last.content).toMatch(/n'a pas rédigé de réponse/);
    expect(last.content).toContain("write_file");
    expect(last.content).toContain("hello.txt");
    expect(deltas(events)).toContain("n'a pas rédigé de réponse");
  });

  it("après un outil en erreur : le repli dit que l'outil a échoué", async () => {
    const core = await makeCore();
    core.settings.set("workspace", tempDir());
    const s = core.sessions.create();
    fakeProvider(core, [
      { toolCalls: [{ id: "t1", name: "read_file", args: { path: "absent.txt" } }] },
      { text: "   " },
    ]);
    await run(core, s.id, "lis absent.txt");
    const last = lastAssistant(core, s.id);
    expect(last.content).toMatch(/read_file.*échoué|échoué.*read_file/);
  });

  it("sans aucun outil : repli court, jamais une bulle vide", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    fakeProvider(core, [{ text: "" }]);
    const events = await run(core, s.id, "salut");
    expect(lastAssistant(core, s.id).content).toMatch(/n'a pas rédigé de réponse/);
    expect(deltas(events)).toMatch(/n'a pas rédigé de réponse/);
  });

  it("une réponse avec du texte n'est pas touchée ; une étape intermédiaire avec outils sans texte non plus", async () => {
    const core = await makeCore();
    core.settings.set("workspace", tempDir());
    const s = core.sessions.create();
    fakeProvider(core, [
      { toolCalls: [{ id: "t1", name: "write_file", args: { path: "a.txt", content: "x" } }] }, // étape intermédiaire : pas de texte
      { text: "C'est fait." },
    ]);
    await run(core, s.id, "crée a.txt");
    const msgs = core.messages.list(s.id).filter((m) => m.role === "assistant");
    expect(msgs.map((m) => m.content)).toEqual(["", "C'est fait."]);
  });
});
