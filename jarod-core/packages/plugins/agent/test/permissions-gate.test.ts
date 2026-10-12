// Le garde unifié branché dans la boucle réelle (executeGuardedTool) : deny bloque, ask exige l'accord.
import type { ChatRequest } from "@jarod/contracts";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { executeGuardedTool } from "../src/agent.js";
import { executeGuardedCommand } from "../src/command-guard.js";
import type {} from "../src/index.js";
import { makeCore, tempDir, testKeys } from "./helpers.js";

async function coreWithRules(rules: { tool: string; decision: "allow" | "ask" | "deny" }[], toolName = "memory_save", args: Record<string, unknown> = { content: "x" }) {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  plugins.permissions = { rules };
  const app = await bootApp(plugins);
  const core = app.agent;
  core.settings.set("autoTitle", false);
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.some((m) => m.role === "tool")
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : {
              text: "",
              thinking: "",
              toolCalls: [{ id: "t1", name: toolName, args }],
              stopReason: "tool_use",
            },
      listModels: async () => [],
    }) as never;
  return core;
}

type Core = Awaited<ReturnType<typeof coreWithRules>>;
const lastToolResult = (core: Core, id: string) =>
  core.messages
    .list(id)
    .filter((m) => m.role === "tool")
    .at(-1);

describe("garde unifié dans la boucle d'agent", () => {
  it("une règle deny bloque l'outil et l'inscrit à l'audit", async () => {
    const core = await coreWithRules([{ tool: "memory_save", decision: "deny" }]);
    const s = core.sessions.create();
    await core.runAndWait(s.id, "retiens", { emit: () => {}, approve: async () => true });
    expect(lastToolResult(core, s.id)).toMatchObject({
      isError: true,
      content: expect.stringMatching(/politique de permissions/),
    });
    expect(core.auditLog()[0]).toMatchObject({ tool: "memory_save", decision: "refusé (règle)" });
    expect(core.memory.list()).toHaveLength(0);
  });

  it("une règle ask exige l'accord même pour un outil non sensible", async () => {
    const core = await coreWithRules([{ tool: "memory", decision: "ask" }]);
    const asked: string[] = [];
    const s = core.sessions.create();
    await core.runAndWait(s.id, "retiens", {
      emit: () => {},
      approve: async (_id, call) => {
        asked.push(call.name);
        return false;
      },
    });
    expect(asked).toEqual(["memory_save"]);
    expect(core.memory.list()).toHaveLength(0);
  });

  it("sans règle, un outil déclaré passe comme avant", async () => {
    const core = await coreWithRules([]);
    const s = core.sessions.create();
    await core.runAndWait(s.id, "retiens", { emit: () => {}, approve: async () => true });
    expect(core.memory.list().map((m) => m.content)).toEqual(["x"]);
  });
});

describe("AV2-008 — portail ABSENT (plugin-permissions non chargé) : refus, jamais « laisse passer »", () => {
  it("executeGuardedTool sans `gate` refuse l'outil, l'inscrit à l'audit, et n'exécute rien", async () => {
    const core = await makeCore();
    let ran = 0;
    core.tools.register({
      name: "danger_x",
      description: "Outil de test",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      async run() {
        ran++;
        return "fait";
      },
    });
    const audit: { tool: string; decision: string }[] = [];
    const r = await executeGuardedTool(
      core.tools,
      "s1",
      { id: "c1", name: "danger_x", args: {} },
      new AbortController().signal,
      { approve: async () => true },
      { ...core.settings.getAll(), autoApproveTools: true },
      { audit: (e) => void audit.push(e as { tool: string; decision: string }) },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Refusé par la politique de permissions/);
    expect(ran).toBe(0);
    expect(audit).toEqual([expect.objectContaining({ tool: "danger_x", decision: "refusé (règle)" })]);
  });

  it("executeGuardedCommand sans `gate` refuse la commande, sans l'exécuter", async () => {
    const core = await makeCore();
    let ran = 0;
    core.commands.register({
      name: "danger-cmd",
      description: "Commande de test",
      source: "builtin",
      run() {
        ran++;
        return { text: "fait" };
      },
    });
    const r = await executeGuardedCommand(core.commands, "/danger-cmd", { sessionId: "s1" }, { approve: async () => true });
    expect(r?.text).toMatch(/Refusé par la politique de permissions/);
    expect(ran).toBe(0);
  });
});

describe("« toujours autoriser » (alwaysAllowTools) dans la boucle d'agent", () => {
  async function dangerous(rules: { tool: string; decision: "allow" | "ask" | "deny" }[]) {
    const core = await coreWithRules(rules, "danger_x", {});
    let ran = 0;
    core.tools.register({
      name: "danger_x",
      description: "Outil sensible de test",
      parameters: { type: "object", properties: {} },
      dangerous: true,
      source: "builtin",
      async run() {
        ran++;
        return "fait";
      },
    });
    return { core, ran: () => ran };
  }

  it("sans réglage : l'accord est demandé ; dans la liste : plus de demande, l'outil tourne, l'audit dit « automatique »", async () => {
    const { core, ran } = await dangerous([]);
    const asked: string[] = [];
    const hooks = { emit: () => {}, approve: async (_id: string, call: { name: string }) => (asked.push(call.name), true) };
    const s = core.sessions.create();
    await core.runAndWait(s.id, "vas-y", hooks);
    expect(asked).toEqual(["danger_x"]);
    expect(core.auditLog()[0]).toMatchObject({ tool: "danger_x", decision: "accordé" });

    core.settings.set("alwaysAllowTools", ["danger_x"]);
    const s2 = core.sessions.create();
    await core.runAndWait(s2.id, "encore", hooks);
    expect(asked).toEqual(["danger_x"]); // pas de seconde demande
    expect(ran()).toBe(2);
    expect(core.auditLog()[0]).toMatchObject({ tool: "danger_x", decision: "automatique" });
  });

  it("une règle « demander » du garde garde la main, et le mode Plan bloque toujours", async () => {
    const { core, ran } = await dangerous([{ tool: "danger_x", decision: "ask" }]);
    core.settings.set("alwaysAllowTools", ["danger_x"]);
    const asked: string[] = [];
    const hooks = { emit: () => {}, approve: async (_id: string, call: { name: string }) => (asked.push(call.name), false) };
    await core.runAndWait(core.sessions.create().id, "vas-y", hooks);
    expect(asked).toEqual(["danger_x"]);
    expect(ran()).toBe(0);

    const plan = await dangerous([]);
    plan.core.settings.patch({ alwaysAllowTools: ["danger_x"], agentMode: "plan" });
    await plan.core.runAndWait(plan.core.sessions.create().id, "vas-y", { emit: () => {}, approve: async () => true });
    expect(plan.ran()).toBe(0);
    expect(plan.core.auditLog()[0]).toMatchObject({ decision: "bloqué (mode Plan)" });
  });
});
