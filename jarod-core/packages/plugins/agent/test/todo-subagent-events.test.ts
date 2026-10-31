// H1 + H11 : ce que l'interface voit d'un sous-agent et de la liste de tâches, du modèle jusqu'aux événements du tour.
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import { subagentObserver, subagentPayload } from "../src/subagent-events.js";
import { SubagentsService } from "../src/subagents.js";
import { TODO_MAX_ITEMS } from "../src/todo-tool.js";
import { makeCore, type TestCore } from "./helpers.js";

function fakeProvider(core: TestCore, steps: Partial<ChatResult>[]): void {
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (_req: ChatRequest, h) => {
      const r: ChatResult = { text: "ok", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1, ...steps.shift() };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
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

const toolEvents = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "tool-event" ? [{ kind: e.kind, payload: e.payload }] : []));
const toolResult = (core: TestCore, id: string, name: string) => core.messages.list(id).find((m) => m.role === "tool" && m.toolName === name);

describe("outil todo (H11)", () => {
  it("remplace la liste, fusionne par id, et prévient l'interface à chaque changement", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    fakeProvider(core, [
      {
        toolCalls: [
          { id: "1", name: "todo", args: { todos: [{ id: "a", content: "Lire le code", status: "in_progress" }, { id: "b", content: "Écrire le test", status: "pending" }] } },
          { id: "2", name: "todo", args: { merge: true, todos: [{ id: "a", content: "Lire le code", status: "completed" }, { id: "c", content: "Livrer", status: "pending" }] } },
          { id: "3", name: "todo", args: {} },
        ],
      },
      { text: "fait" },
    ]);
    const events = await run(core, s.id, "planifie");
    const updates = toolEvents(events).filter((e) => e.kind === "todo.updated");
    expect(updates).toHaveLength(2); // la lecture sans `todos` ne change rien : pas d'événement
    expect(updates[0]!.payload).toMatchObject({ revision: 1, todos: [{ id: "a", status: "in_progress" }, { id: "b", status: "pending" }] });
    expect(updates[1]!.payload).toMatchObject({
      revision: 2,
      todos: [{ id: "a", status: "completed" }, { id: "b", status: "pending" }, { id: "c", status: "pending" }],
    });
    expect(JSON.parse(toolResult(core, s.id, "todo")!.content)).toBeDefined();
    expect(core.state.get(s.id, "todos")).toMatchObject({ revision: 2 });
  });

  it("refuse deux tâches en cours, un état inconnu, un doublon, une liste trop longue — et n'écrit rien", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const many = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({ id: String(i), content: `t${i}` }));
    fakeProvider(core, [
      {
        toolCalls: [
          { id: "1", name: "todo", args: { todos: [{ id: "a", content: "x", status: "in_progress" }, { id: "b", content: "y", status: "in_progress" }] } },
          { id: "2", name: "todo", args: { todos: [{ id: "a", content: "x", status: "fait" }] } },
          { id: "3", name: "todo", args: { todos: [{ id: "a", content: "x" }, { id: "a", content: "y" }] } },
          { id: "4", name: "todo", args: { todos: many } },
        ],
      },
      { text: "ok" },
    ]);
    const events = await run(core, s.id, "mal");
    expect(toolEvents(events)).toEqual([]);
    expect(core.state.get(s.id, "todos")).toBeUndefined();
    const errors = core.messages.list(s.id).filter((m) => m.role === "tool").map((m) => [m.isError, m.content]);
    expect(errors).toHaveLength(4);
    for (const [isError] of errors) expect(isError).toBe(true);
  });

  it("ne demande pas d'accord (il n'écrit que l'état de la conversation)", async () => {
    const core = await makeCore();
    expect(core.tools.get("todo")?.dangerous).toBeFalsy();
    expect(core.tools.get("todo")?.description).toMatch(/plan de la mission/);
  });
});

describe("événements de sous-agent (H1)", () => {
  it("annonce la demande, le départ puis la fin, avec durée et résumé", async () => {
    const seen: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    let t = 1_000;
    const service = new SubagentsService({ now: () => t });
    const observe = subagentObserver({ notify: (kind, payload) => void seen.push({ kind, payload }) });
    const result = service.run(
      "Chercher les fichiers de config",
      "s1",
      async () => {
        t += 2_500;
        return "Trouvé   trois fichiers\nde config.";
      },
      undefined,
      observe,
    );
    await result;
    expect(seen.map((e) => e.kind)).toEqual(["subagent.spawn_requested", "subagent.start", "subagent.complete"]);
    expect(seen[0]!.payload).toMatchObject({ goal: "Chercher les fichiers de config", subagent_id: "sa-1", status: "running" });
    expect(seen[2]!.payload).toMatchObject({ status: "completed", duration_seconds: 2.5, summary: "Trouvé trois fichiers de config." });
  });

  it("une panne ou un arrêt se disent comme tels, sans casser l'exécution si l'écouteur lève", async () => {
    const seen: string[] = [];
    const service = new SubagentsService();
    const failing = service.run("T1", "s1", async () => Promise.reject(new Error("réseau coupé")), undefined, (o) => {
      seen.push(`${o.phase}:${subagentPayload(o).status}:${subagentPayload(o).summary ?? ""}`);
      throw new Error("écouteur cassé");
    });
    await expect(failing).rejects.toThrow("réseau coupé");
    expect(seen).toEqual(["start:running:", "complete:failed:réseau coupé"]);

    const ctl = new AbortController();
    const cancelled = service.run("T2", "s1", (_t, signal) => new Promise<string>((_, rej) => signal.addEventListener("abort", () => rej(new Error("stop")))), ctl.signal, (o) => {
      if (o.phase === "complete") seen.push(`T2:${subagentPayload(o).status}`);
    });
    ctl.abort();
    await expect(cancelled).rejects.toThrow();
    expect(seen.at(-1)).toBe("T2:interrupted");
  });

  it("sans écouteur (tâche planifiée, sous-agent), il n'y a rien à relayer", () => {
    expect(subagentObserver({})).toBeUndefined();
  });

  it("delegate_task passe par le même chemin : le tour reçoit les trois événements", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    fakeProvider(core, [{ toolCalls: [{ id: "1", name: "delegate_task", args: { task: "Compter les fichiers" } }] }, { text: "enfant: fini" }, { text: "terminé" }]);
    const events = await run(core, s.id, "délègue");
    const kinds = toolEvents(events).map((e) => e.kind);
    expect(kinds).toEqual(["subagent.spawn_requested", "subagent.start", "subagent.complete"]);
  });
});
