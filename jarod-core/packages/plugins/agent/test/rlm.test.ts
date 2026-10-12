// Jarod-cordis (Q18) : sous-agents non bloquants — SANK-AI `rlm-subagent` (MIT), enfants en lecture seule.
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import { makeCore, type TestCore } from "./helpers.js";

/** Chaque appel du modèle attend qu'on le libère : on voit ainsi l'enfant « en cours ». */
function gatedProvider(core: TestCore) {
  const requests: ChatRequest[] = [];
  const gates: ((text: string) => void)[] = [];
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: (req, _h) =>
      new Promise<ChatResult>((resolve, reject) => {
        requests.push(structuredClone({ ...req, signal: undefined }));
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        gates.push((text) => resolve({ text, thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1 }));
      }),
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return { requests, release: (i: number, text: string) => gates[i]!(text) };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const call = (core: TestCore, name: string, args: Record<string, unknown>, sessionId: string) =>
  core.tools.get(name)!.run(args, { sessionId, workspace: null });

describe("sous-agents non bloquants (Q18)", () => {
  it("spawn_subagent rend la main tout de suite ; subagent_result dit « en cours » puis rend le compte rendu", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const p = gatedProvider(core);
    const handle = JSON.parse(await call(core, "spawn_subagent", { task: "liste les fichiers", name: "explo" }, s.id));
    expect(handle).toMatchObject({ name: "explo", status: "lancé" });
    await tick();
    expect(p.requests).toHaveLength(1);
    expect(await call(core, "subagent_result", { id: "explo" }, s.id)).toBe(`explo (${handle.id}) : en cours.`);
    expect(JSON.parse(await call(core, "subagent_list", {}, s.id))).toEqual([
      { id: handle.id, name: "explo", status: "running", task: "liste les fichiers" },
    ]);
    p.release(0, "trois fichiers");
    await tick();
    expect(await call(core, "subagent_result", { id: handle.id }, s.id)).toBe(`explo (${handle.id}) : terminé.\n\ntrois fichiers`);
  });

  it("enfant en lecture seule : ni écriture, ni lancement d'autres sous-agents", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const p = gatedProvider(core);
    await call(core, "spawn_subagent", { task: "t" }, s.id);
    await tick();
    const names = p.requests[0]!.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    for (const n of ["write_file", "run_shell", "spawn_subagent", "subagent_cancel", "delegate_task", "state_set"]) {
      expect(names, n).not.toContain(n);
    }
    p.release(0, "ok");
  });

  it("même borne que delegate_task (3) : le 4e est refusé, lisiblement", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const p = gatedProvider(core);
    for (let i = 0; i < 3; i++) await call(core, "spawn_subagent", { task: `t${i}` }, s.id);
    await expect(call(core, "spawn_subagent", { task: "t3" }, s.id)).rejects.toThrow(/SUBAGENT_LIMIT: 3/);
    await tick();
    for (let i = 0; i < 3; i++) p.release(i, "ok");
  });

  it("propres à la conversation ; annulation ; arrêt du kernel et suppression de la conversation les arrêtent", async () => {
    const core = await makeCore();
    const a = core.sessions.create();
    const b = core.sessions.create();
    gatedProvider(core);
    const h = JSON.parse(await call(core, "spawn_subagent", { task: "t", name: "x" }, a.id));
    expect(await call(core, "subagent_result", { id: "x" }, b.id)).toMatch(/^Aucun sous-agent « x » dans cette conversation/);
    expect(await call(core, "subagent_cancel", { id: "x" }, a.id)).toBe("x : arrêt demandé.");
    await tick();
    expect(await call(core, "subagent_result", { id: h.id }, a.id)).toBe(`x (${h.id}) : annulé.`);

    const h2 = JSON.parse(await call(core, "spawn_subagent", { task: "t" }, a.id));
    core.stopAll();
    await tick();
    expect(core.subagents.get(h2.id)?.status).toBe("cancelled");

    const h3 = JSON.parse(await call(core, "spawn_subagent", { task: "t" }, b.id));
    core.sessions.delete(b.id);
    await tick();
    expect(core.subagents.get(h3.id)?.status).toBe("cancelled");
  });
});
