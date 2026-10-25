/**
 * Pilotage en cours de tour : un message écrit pendant que l'agent travaille entre dans la conversation à l'étape suivante
 * (jamais au milieu d'un appel), et n'est pas perdu si la dernière réponse venait de partir sans outil.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/agent.js";
import { makeCore, tempDir } from "./helpers.js";

type Req = { messages: { role: string; content: string }[] };
const STOP = { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" };

/** Un client de modèle scripté : `script(n, req)` rend la réponse du n-ième appel. */
function scripted(core: Awaited<ReturnType<typeof makeCore>>, script: (n: number, req: Req) => unknown) {
  let calls = 0;
  const requests: Req[] = [];
  core.providers.client = () =>
    ({
      chat: async (req: never) => {
        requests.push(req as Req);
        return script(calls++, req as Req);
      },
      listModels: async () => [],
    }) as never;
  core.settings.set("autoTitle", false);
  return { requests, calls: () => calls };
}

/** Le tour d'une conversation avec une boîte de pilotage ; rend la main au `done`. */
function runTurn(core: Awaited<ReturnType<typeof makeCore>>, sessionId: string, text: string, inbox: string[]): Promise<AgentEvent[]> {
  return new Promise((resolve) => {
    const events: AgentEvent[] = [];
    core.start(sessionId, text, {
      approve: async () => true,
      emit: (e) => {
        events.push(e);
        if (e.type === "done") resolve(events);
      },
      steering: { peek: () => inbox.length > 0, take: () => inbox.splice(0) },
    });
  });
}

describe("pilotage en cours de tour", () => {
  it("un message reçu pendant une étape est lu avant l'appel suivant, après le résultat de l'outil", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir(), agentMode: "build" });
    const inbox: string[] = [];
    const model = scripted(core, (n) => {
      if (n === 0) {
        inbox.push("plutôt, ne touche qu'au dossier src");
        return { text: "", thinking: "", toolCalls: [{ id: "c1", name: "list_dir", args: { path: "." } }], stopReason: "tool_use" };
      }
      return STOP;
    });

    const sessionId = core.sessions.create().id;
    await runTurn(core, sessionId, "liste le dossier", inbox);

    expect(model.calls()).toBe(2);
    const second = model.requests[1]!.messages;
    const roles = second.map((m) => m.role);
    expect(roles.slice(-2)).toEqual(["tool", "user"]);
    expect(second.at(-1)?.content).toBe("plutôt, ne touche qu'au dossier src");
    expect(inbox).toEqual([]);
    // La consigne est dans l'historique : un rechargement de la conversation la retrouve.
    expect(core.messages.list(sessionId).some((m) => m.role === "user" && m.content === "plutôt, ne touche qu'au dossier src")).toBe(true);
    await core.dispose();
  });

  it("une consigne arrivée pendant la dernière réponse prolonge le tour au lieu d'être perdue", async () => {
    const core = await makeCore();
    const inbox: string[] = [];
    const model = scripted(core, (n) => {
      if (n === 0) {
        inbox.push("ajoute aussi un exemple");
        return { text: "voilà", thinking: "", toolCalls: [], stopReason: "stop" };
      }
      return { text: "exemple ajouté", thinking: "", toolCalls: [], stopReason: "stop" };
    });

    await runTurn(core, core.sessions.create().id, "explique", inbox);

    expect(model.calls()).toBe(2);
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "user", content: "ajoute aussi un exemple" });
    await core.dispose();
  });

  it("sans pilotage, le tour n'appelle le modèle qu'une fois", async () => {
    const core = await makeCore();
    const model = scripted(core, () => STOP);
    await runTurn(core, core.sessions.create().id, "bonjour", []);
    expect(model.calls()).toBe(1);
    await core.dispose();
  });
});
