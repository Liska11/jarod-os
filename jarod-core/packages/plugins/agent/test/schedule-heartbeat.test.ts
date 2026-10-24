// V-17 — le tour d'une tâche planifiée donne signe de vie au planificateur (`beat`) à chaque événement : c'est ce qui repousse son bail
// et sa borne d'inactivité. Sans `beat`, le tour se déroule comme avant.
import type { ChatResult, ProviderClient } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { makeCore } from "./helpers.js";

describe("tâche planifiée : signes de vie (V-17)", () => {
  it("chaque événement du tour appelle beat ; le tour se termine normalement", async () => {
    const core = await makeCore();
    const client: ProviderClient = {
      listModels: async () => ["m"],
      chat: async (_req, h) => {
        const r: ChatResult = { text: "rapport prêt", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 5, outputTokens: 3 };
        h.onText?.("rapport ");
        h.onText?.("prêt");
        return r;
      },
    };
    core.providers.client = () => client;
    core.settings.set("autoTitle", false);
    let beats = 0;
    const r = await core.runSchedule(
      { id: "sch", name: "Rapport", prompt: "Fais le rapport", spec: { kind: "interval", minutes: 60 }, sessionId: null, enabled: true, lastRun: null, nextRun: null, lastStatus: null, createdAt: 0, deliver: null },
      () => beats++,
    );
    expect(r).toMatchObject({ ok: true, summary: "rapport prêt" });
    expect(beats).toBeGreaterThanOrEqual(3);
  });
});
