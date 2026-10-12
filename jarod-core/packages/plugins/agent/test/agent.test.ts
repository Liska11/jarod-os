// Portage de packages/core/test/agent.test.ts (rév. 2e180305).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import { trimHistory } from "../src/agent.js";
import type { TestCore as JarodCore } from "./helpers.js";
import type { ChatRequest, ChatResult, ProviderClient, StreamHandlers } from "@jarod/contracts";
import { makeCore, tempDir } from "./helpers.js";

type Step = Partial<ChatResult> | ((req: ChatRequest, h: StreamHandlers) => Promise<ChatResult>);

function fakeProvider(core: JarodCore, steps: Step[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const step = steps.shift();
      if (typeof step === "function") return step(req, h);
      const r: ChatResult = {
        text: "",
        thinking: "",
        toolCalls: [],
        stopReason: "end",
        inputTokens: 10,
        outputTokens: 5,
        ...step,
      };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

function run(core: JarodCore, sessionId: string, text: string, approve = true) {
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

describe("agent loop", () => {
  it("streams an answer, persists it and titles the session", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [{ text: "Bonjour !" }]);
    const { events } = await run(core, s.id, "Salut Jarod, ça va ?");
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text)).toEqual(["Bonjour !"]);
    expect(core.messages.list(s.id).map((m) => [m.role, m.content])).toEqual([
      ["user", "Salut Jarod, ça va ?"],
      ["assistant", "Bonjour !"],
    ]);
    expect(core.sessions.get(s.id)?.title).toBe("Salut Jarod, ça va ?");
    expect(reqs[0]!.system).toContain("Tu es Jarod");
    expect(reqs[0]!.tools.map((t) => t.name)).toContain("read_file");
    expect(core.sessionUsage(s.id)).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("executes an approved dangerous tool and loops back with its result", async () => {
    const core = await makeCore();
    const ws = tempDir();
    core.settings.set("workspace", ws);
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [
      {
        text: "J'écris le fichier.",
        toolCalls: [{ id: "t1", name: "write_file", args: { path: "hello.txt", content: "coucou" } }],
      },
      { text: "C'est fait." },
    ]);
    const { approvals } = await run(core, s.id, "crée hello.txt");
    expect(approvals).toEqual(["write_file"]);
    expect(existsSync(join(ws, "hello.txt"))).toBe(true);
    expect(core.messages.list(s.id).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const second = reqs[1]!.messages;
    expect(second.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "t1",
      content: expect.stringContaining("hello.txt"),
    });
  });

  it("reports a refused tool call to the model as an error", async () => {
    const core = await makeCore();
    core.settings.set("workspace", tempDir());
    const s = core.sessions.create();
    fakeProvider(core, [
      { toolCalls: [{ id: "t1", name: "run_shell", args: { command: "echo x" } }] },
      { text: "D'accord, je n'y touche pas." },
    ]);
    await run(core, s.id, "lance echo", false);
    const tool = core.messages.list(s.id).find((m) => m.role === "tool")!;
    expect(tool).toMatchObject({ isError: true, content: "L'utilisateur a refusé cette action." });
  });

  it("skips approval when auto-approve is on, and rejects invalid arguments", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir(), autoApproveTools: true });
    const s = core.sessions.create();
    fakeProvider(core, [
      {
        toolCalls: [
          { id: "a", name: "write_file", args: { path: "x.txt" } },
          { id: "b", name: "nope", args: {} },
        ],
      },
      { text: "ok" },
    ]);
    const { approvals } = await run(core, s.id, "go");
    expect(approvals).toEqual([]);
    const tools = core.messages.list(s.id).filter((m) => m.role === "tool");
    expect(tools[0]!.content).toMatch(/manquant : content/);
    expect(tools[1]!.content).toMatch(/Outil inconnu/);
  });

  it("surfaces provider errors and still finishes", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    fakeProvider(core, [
      async () => {
        throw new Error("clé invalide");
      },
    ]);
    const { events } = await run(core, s.id, "hello");
    expect(events.find((e) => e.type === "error")).toMatchObject({ error: "clé invalide" });
    expect(core.isRunning(s.id)).toBe(false);
  });

  it("stops mid-stream and keeps the partial answer", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    fakeProvider(core, [
      (req, h) =>
        new Promise((_res, rej) => {
          h.onText?.("Début de rép");
          req.signal!.addEventListener("abort", () => rej(new Error("aborted")));
          setTimeout(() => core.stop(s.id), 10);
        }),
    ]);
    await run(core, s.id, "raconte");
    const last = core.messages.list(s.id).at(-1)!;
    expect(last.content).toContain("Début de rép");
    expect(last.content).toContain("interrompu");
  });

  it("injects memories and skills into the system prompt; load_skill returns the body", async () => {
    const core = await makeCore();
    await core.init();
    core.memory.add("Préfère le tutoiement", "preference");
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, s.id, "bonjour");
    expect(reqs[0]!.system).toContain("Préfère le tutoiement");
    expect(reqs[0]!.system).toContain("revue-de-code");
    const body = await core.tools.get("load_skill")!.run({ id: "revue-de-code" }, { sessionId: s.id, workspace: null });
    expect(body).toContain("gravité");
  });

  it("handles /retry, /undo and unknown commands", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [{ text: "v1" }, { text: "v2" }]);
    await run(core, s.id, "question");
    await run(core, s.id, "/retry");
    expect(reqs).toHaveLength(2);
    expect(core.messages.list(s.id).map((m) => m.content)).toEqual(["question", "v2"]);
    const hooks = { emit: () => {}, approve: async () => true };
    const undo = await core.submit(s.id, "/undo", hooks);
    expect(undo).toEqual({ kind: "command", result: { action: "undo", payload: "question" } });
    expect(core.messages.list(s.id)).toHaveLength(0);
    const unknown = await core.submit(s.id, "/zzz", hooks);
    expect(unknown.kind === "command" && unknown.result.text).toMatch(/inconnue/);
    const model = await core.submit(s.id, "/model openai/gpt-x", hooks);
    expect(model.kind).toBe("command");
    expect(core.settings.getAll()).toMatchObject({ activeProvider: "openai", activeModel: "gpt-x" });
  });

  it("refuses a second concurrent run in the same session", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    let release!: () => void;
    fakeProvider(core, [
      () =>
        new Promise(
          (res) =>
            (release = () =>
              res({ text: "ok", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 0, outputTokens: 0 })),
        ),
    ]);
    const hooks = { emit: () => {}, approve: async () => true };
    expect(await core.submit(s.id, "un", hooks)).toEqual({ kind: "started" });
    expect(await core.submit(s.id, "deux", hooks)).toEqual({ kind: "busy" });
    await new Promise((r) => setTimeout(r, 5));
    release();
  });

  it("trims history at user boundaries", () => {
    const big = "x".repeat(100);
    const turns = [
      { role: "user" as const, content: big },
      { role: "assistant" as const, content: big, toolCalls: [{ id: "1", name: "t", args: {} }] },
      { role: "tool" as const, content: big },
      { role: "user" as const, content: "latest" },
    ];
    const out = trimHistory(turns, 150);
    expect(out[0]!.role).toBe("user");
    expect(out.at(-1)!.content).toBe("latest");
  });
});

describe("garde-fous de boucle, dans la boucle elle-même", () => {
  it("rappelle au modèle qu'il tourne en rond, dans le résultat de l'outil qu'il vient de refaire", async () => {
    const core = await makeCore();
    // Une session doit exister AVANT d'y soumettre : un identifiant littéral ne fait rien du tout,
    // et le test expire au lieu d'échouer — c'est ce qui m'a coûté quatre passages.
    const session = core.sessions.create();
    const call = { id: "c1", name: "write_file", args: { path: "meme.txt", content: "meme contenu" } };
    fakeProvider(core, [
      { toolCalls: [call] },
      { toolCalls: [{ ...call, id: "c2" }] },
      { toolCalls: [{ ...call, id: "c3" }] },
      { text: "je change d'approche" },
    ]);

    const { events } = await run(core, session.id, "écris ce fichier");
    const results = events
      .filter((e) => e.type === "message" && e.message.role === "tool")
      .map((e) => (e.type === "message" ? e.message.content : ""));

    expect(results).toHaveLength(3);
    // Les deux premiers passages sont muets : un agent qui travaille n'est pas un agent bloqué.
    expect(results[0]).not.toMatch(/Change d'approche/);
    expect(results[1]).not.toMatch(/Change d'approche/);
    // Le troisième porte le rappel, et il est arrivé jusqu'au modèle dans le fil de la session.
    expect(results[2]).toMatch(/write_file 3 fois/);
    expect(results[2]).toMatch(/Change d'approche/);
  });
});
