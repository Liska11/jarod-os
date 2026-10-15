/**
 * R3.5 — le chemin RLM : un enfant lancé par `spawn_subagent` n'a de signal que celui du service,
 * puisqu'aucun appelant n'en porte un. Il doit donc être arrêtable par l'outil `subagent_cancel`
 * (et par `cancelAll` à l'arrêt), sinon un sous-agent de fond survivrait à tout.
 */
import { describe, expect, it } from "vitest";
import { RlmChildren, rlmTools } from "../src/rlm.js";
import { SubagentsService } from "../src/subagents.js";

const ctx = { sessionId: "s1", workspace: null };

describe("R3.5 — annulation d'un enfant RLM sans signal d'appelant", () => {
  it("subagent_cancel coupe le travail de l'enfant", async () => {
    const subagents = new SubagentsService();
    let seen: AbortSignal | undefined;
    const rlm = new RlmChildren(
      subagents,
      (_task, signal) =>
        new Promise<string>((_resolve, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const tools = rlmTools(rlm, subagents);
    const spawn = tools.find((t) => t.name === "spawn_subagent")!;
    const cancel = tools.find((t) => t.name === "subagent_cancel")!;

    const launched = JSON.parse(String(await spawn.run({ task: "explore le dépôt" }, ctx))) as { id: string };
    await Promise.resolve();
    expect(seen?.aborted, "l'enfant travaille").toBe(false);

    expect(String(await cancel.run({ id: launched.id }, ctx))).toMatch(/arrêt demandé/);
    expect(seen?.aborted, "l'outil a coupé le signal du travail").toBe(true);
    expect(subagents.get(launched.id)?.status).toBe("cancelled");
    // Un second arrêt ne relance rien, et le dit.
    expect(String(await cancel.run({ id: launched.id }, ctx))).toMatch(/n'est plus en cours/);
  });
});
