// Jarod-cordis (G4, décision 2026-09-28) : plafond de tokens/coût par conversation — sans équivalent
// dans les sources (gap-reel.md G4), donc tests neufs, sur le même kernel réel que agent.test.ts.
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import { budgetRatio, crossedWarning, limitsFor, usageOf } from "../src/budget.js";
import { makeCore, tempDir, type TestCore } from "./helpers.js";

function fakeProvider(core: TestCore, steps: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r: ChatResult = {
        text: "ok",
        thinking: "",
        toolCalls: [],
        stopReason: "end",
        inputTokens: 10,
        outputTokens: 5,
        ...steps.shift(),
      };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

function run(core: TestCore, sessionId: string, text: string) {
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

const statuses = (ev: AgentEvent[]) =>
  ev.filter((e) => e.type === "status").map((e) => (e as { status: string }).status);
const errors = (ev: AgentEvent[]) => ev.filter((e) => e.type === "error").map((e) => (e as { error: string }).error);

describe("plafond par conversation (G4)", () => {
  it("éteint par défaut : aucun statut, aucun arrêt", async () => {
    const core = await makeCore();
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [{ inputTokens: 900_000, outputTokens: 900_000 }, {}]);
    await run(core, s.id, "un");
    const ev = await run(core, s.id, "deux");
    expect(reqs).toHaveLength(2);
    expect(errors(ev)).toEqual([]);
    expect(limitsFor(core.settings.get("sessionBudget"), s.id)).toEqual({ maxTokens: 0, maxCostUsd: 0 });
  });

  it("alerte une seule fois au franchissement de 80 %, puis arrête avant l'appel suivant à 100 %", async () => {
    const core = await makeCore();
    core.settings.set("sessionBudget", { maxTokens: 100, maxCostUsd: 0, perSession: {} });
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [
      { inputTokens: 40, outputTokens: 10 }, // 50 %
      { inputTokens: 30, outputTokens: 5 }, // 85 % → alerte
      { inputTokens: 5, outputTokens: 5 }, // 95 % → pas de 2e alerte
      { inputTokens: 10, outputTokens: 5 }, // 110 % : l'appel en cours dépasse
    ]);
    expect(statuses(await run(core, s.id, "a")).filter((x) => x.includes("plafond"))).toEqual([]);
    const warned = await run(core, s.id, "b");
    expect(statuses(warned).filter((x) => x.includes("plafond"))).toEqual([
      "80 % du plafond de la conversation atteint (85 / 100 tokens).",
    ]);
    expect(statuses(await run(core, s.id, "c")).filter((x) => x.includes("plafond"))).toEqual([]);
    expect(errors(await run(core, s.id, "d"))).toEqual([]);
    expect(reqs).toHaveLength(4);

    const stopped = await run(core, s.id, "e");
    expect(reqs).toHaveLength(4); // aucun appel du modèle
    expect(errors(stopped)).toEqual([
      "Plafond de la conversation atteint (110 / 100 tokens). Pour poursuivre, relevez-le : `/budget <tokens> [<usd>]`.",
    ]);
    // Le message de l'utilisateur est gardé : la conversation reprend dès que le plafond est relevé.
    expect(core.messages.list(s.id).at(-1)).toMatchObject({ role: "user", content: "e" });
  });

  it("n'exécute plus les outils demandés par la réponse qui dépasse, et arrête le tour", async () => {
    const core = await makeCore();
    const ws = tempDir();
    core.settings.patch({ workspace: ws, autoApproveTools: true });
    core.settings.set("sessionBudget", { maxTokens: 20, maxCostUsd: 0, perSession: {} });
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [
      { inputTokens: 20, outputTokens: 5, toolCalls: [{ id: "t1", name: "write_file", args: { path: "x.txt", content: "x" } }] },
      { text: "jamais demandé" },
    ]);
    const ev = await run(core, s.id, "écris");
    expect(reqs).toHaveLength(1);
    const tool = core.messages.list(s.id).find((m) => m.role === "tool")!;
    expect(tool).toMatchObject({ isError: true, content: "Non exécuté : plafond de la conversation atteint.", toolCallId: "t1" });
    expect(errors(ev)).toHaveLength(1);
    expect(errors(ev)[0]).toContain("25 / 20 tokens");
  });

  it("/budget relève le plafond de CETTE conversation seulement ; reset revient au global ; supprimée = oubliée", async () => {
    const core = await makeCore();
    core.settings.set("sessionBudget", { maxTokens: 10, maxCostUsd: 0, perSession: {} });
    const a = core.sessions.create();
    const b = core.sessions.create();
    const reqs = fakeProvider(core, [{}, {}, {}]);
    await run(core, a.id, "un"); // 15 / 10
    expect(errors(await run(core, a.id, "deux"))).toHaveLength(1);
    expect(reqs).toHaveLength(1);

    const shown = await core.commands.execute("/budget 1000", { sessionId: a.id });
    expect(shown?.text).toBe("**Plafond (propre à cette conversation) :** 15 / 1 000 tokens — 2 %");
    expect(core.settings.get("sessionBudget").maxTokens).toBe(10); // le global ne bouge pas
    const resumed = await run(core, a.id, "trois");
    expect(errors(resumed)).toEqual([]);
    expect(reqs).toHaveLength(2);

    // L'autre conversation garde le plafond global.
    await run(core, b.id, "un");
    expect(errors(await run(core, b.id, "deux"))).toHaveLength(1);
    expect(reqs).toHaveLength(3);

    expect((await core.commands.execute("/budget beaucoup", { sessionId: a.id }))?.text).toContain("Usage : /budget");
    expect((await core.commands.execute("/budget -1", { sessionId: a.id }))?.text).toContain("Usage : /budget");
    const reset = await core.commands.execute("/budget reset", { sessionId: a.id });
    expect(reset?.text).toContain("(plafond global)");
    expect(core.settings.get("sessionBudget").perSession).toEqual({});

    // Le plafond global se règle aussi par la commande (aucun écran ne l'expose), sans conversation.
    expect((await core.commands.execute("/budget global 50000 1,5", { sessionId: null }))?.text).toBe(
      "**Plafond global (par conversation) :** 50 000 tokens · 1.5 $",
    );
    expect(core.settings.get("sessionBudget")).toMatchObject({ maxTokens: 50_000, maxCostUsd: 1.5, perSession: {} });
    expect((await core.commands.execute("/budget global 0 0", { sessionId: null }))?.text).toContain("aucun");
    core.settings.set("sessionBudget", { ...core.settings.get("sessionBudget"), maxTokens: 10 });

    await core.commands.execute("/budget 0", { sessionId: b.id }); // 0 = aucun plafond pour b
    expect(core.settings.get("sessionBudget").perSession[b.id]).toEqual({ maxTokens: 0, maxCostUsd: 0 });
    core.sessions.delete(b.id);
    expect(core.settings.get("sessionBudget").perSession).toEqual({});
  });

  it("plafond de coût : joue au barème, jamais pour un modèle hors barème (coût inconnu)", async () => {
    const core = await makeCore();
    // claude-opus-5 : 5 $ / 25 $ par million → 100 + 20 tokens = 0,001 $.
    core.settings.set("sessionBudget", { maxTokens: 0, maxCostUsd: 0.001, perSession: {} });
    const priced = core.sessions.create();
    const reqs = fakeProvider(core, [{ inputTokens: 100, outputTokens: 20 }, {}, {}, {}]);
    await run(core, priced.id, "un");
    const stop = errors(await run(core, priced.id, "deux"));
    expect(stop[0]).toContain("~0.0010 / 0.001 $");
    expect(reqs).toHaveLength(1);

    core.settings.set("activeModel", "fake-1");
    const local = core.sessions.create();
    await run(core, local.id, "un");
    await run(core, local.id, "deux");
    expect(reqs).toHaveLength(3);
    expect(core.sessionUsage(local.id).costUsd).toBeNull();
    const shown = await core.commands.execute("/budget", { sessionId: local.id });
    expect(shown?.text).toBe("**Plafond (plafond global) :** coût inconnu pour ce modèle / 0.001 $");
  });

  it("franchissement calculé sans état (même résultat après redémarrage)", () => {
    const l = { maxTokens: 100, maxCostUsd: 0 };
    const msg = (inputTokens: number) => ({ id: "x", sessionId: "s", role: "assistant" as const, content: "", createdAt: 0, inputTokens, outputTokens: 0 });
    expect(crossedWarning([msg(50), msg(35)], l)).toBe(true);
    expect(crossedWarning([msg(50), msg(35), msg(5)], l)).toBe(false);
    expect(crossedWarning([msg(50), msg(60)], l)).toBe(false); // saut direct au-delà de 100 % : l'arrêt suffit
    expect(budgetRatio(usageOf([msg(50)]), { maxTokens: 0, maxCostUsd: 0 })).toBeNull();
  });
});
