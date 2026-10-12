// §3.6-5 : le contrôleur du sous-agent doit être réellement annulable. Le cas `signal === undefined`
// fabriquait un contrôleur aussitôt jeté, donc plus rien en aval n'était interruptible ; et le signal
// de l'appelant doit continuer d'atteindre l'appel en cours.
import { describe, expect, it } from "vitest";
import type { ChatResult, ProviderClient } from "@jarod/contracts";
import { makeCore } from "./helpers.js";

describe("annulation d'un sous-agent", () => {
  it("sans signal d'appelant, le travail du sous-agent reste interruptible", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    let vu: AbortSignal | undefined;
    const client: ProviderClient = {
      listModels: async () => ["fake-1"],
      chat: async (req): Promise<ChatResult> => {
        vu = req.signal;
        return { text: "fini", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1 };
      },
    };
    core.providers.client = () => client;
    await expect(core.agent.runSubAgent("tâche", undefined, s.id, 1)).resolves.toBe("fini");
    // Le contrôleur n'est plus jeté : à la sortie, il est annulé.
    expect(vu?.aborted).toBe(true);
  });

  it("relaie l'annulation de l'appelant jusqu'à l'appel en cours", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const appelant = new AbortController();
    let vu: AbortSignal | undefined;
    const client: ProviderClient = {
      listModels: async () => ["fake-1"],
      chat: (req) => {
        vu = req.signal;
        return new Promise<ChatResult>((_resolve, reject) => {
          req.signal?.addEventListener("abort", () => reject(new Error("annulé")), { once: true });
          // L'utilisateur annule pendant que le sous-agent travaille.
          appelant.abort();
        });
      },
    };
    core.providers.client = () => client;
    await expect(core.agent.runSubAgent("tâche", appelant.signal, s.id, 1)).rejects.toThrow("annulé");
    expect(vu?.aborted).toBe(true);
  });
});
