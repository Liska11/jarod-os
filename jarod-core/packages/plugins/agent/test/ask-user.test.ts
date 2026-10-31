// H2 : `ask_user` — la question à choix de l'agent, de l'outil jusqu'à la réponse qui reprend le tour.
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import type { ToolContext } from "@jarod/plugin-tools";
import type { AgentHooks } from "../src/agent.js";
import { ASK_CHOICES_MAX, askUserTool } from "../src/ask-user-tool.js";
import { makeCore } from "./helpers.js";

const ctx = (ask?: ToolContext["ask"]): ToolContext => ({ sessionId: "s1", workspace: null, ...(ask ? { ask } : {}) });
const run = (args: Record<string, unknown>, c: ToolContext) => askUserTool().run(args, c);

describe("ask_user (H2)", () => {
  it("transmet la question et les choix nettoyés, rend la réponse de l'utilisateur", async () => {
    const seen: unknown[] = [];
    const out = await run({ question: "  Quel   fichier ? ", choices: ["a.txt", " a.txt ", "", "b.txt"], multi_select: true }, ctx(async (q) => (seen.push(q), "b.txt")));
    expect(seen).toEqual([{ question: "Quel fichier ?", choices: ["a.txt", "b.txt"], multiSelect: true }]);
    expect(out).toBe("Réponse de l'utilisateur : b.txt");
  });

  it("une question ouverte n'envoie ni choix ni multi-sélection (même demandée sans choix)", async () => {
    const seen: unknown[] = [];
    await run({ question: "Un mot ?", multi_select: true }, ctx(async (q) => (seen.push(q), "oui")));
    expect(seen).toEqual([{ question: "Un mot ?" }]);
  });

  it("dit ce qu'il faut faire quand l'utilisateur passe, ne répond pas, ou que personne ne peut répondre", async () => {
    expect(await run({ question: "Ok ?" }, ctx(async () => ""))).toMatch(/passé la question/);
    expect(await run({ question: "Ok ?" }, ctx(async () => null))).toMatch(/Aucune réponse/);
    expect(await run({ question: "Ok ?" }, ctx())).toMatch(/Personne ne peut répondre/);
  });

  it("refuse une question vide ou trop de choix, sans rien demander", async () => {
    let asked = 0;
    const c = ctx(async () => (asked++, "x"));
    await expect(run({ question: "   " }, c)).rejects.toThrow(/vide/);
    await expect(run({ question: "q", choices: Array.from({ length: ASK_CHOICES_MAX + 1 }, (_, i) => `c${i}`) }, c)).rejects.toThrow(/Trop de choix/);
    await expect(run({ question: "q", choices: "oui" }, c)).rejects.toThrow(/liste/);
    expect(asked).toBe(0);
  });

  it("ne demande pas d'accord : poser une question n'a aucun effet", () => {
    expect(askUserTool().dangerous).toBe(false);
  });
});

describe("ask_user dans le vrai tour (H2)", () => {
  const turn = async (clarify?: AgentHooks["clarify"]) => {
    const core = await makeCore();
    const s = core.sessions.create();
    const client: ProviderClient = {
      listModels: async () => ["fake-1"],
      chat: async (_req: ChatRequest, h) => {
        const r: ChatResult = { text: "ok", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1, ...steps.shift() };
        if (r.text) h.onText?.(r.text);
        return r;
      },
    };
    const steps: Partial<ChatResult>[] = [{ toolCalls: [{ id: "1", name: "ask_user", args: { question: "Quel dossier ?", choices: ["docs", "src"] } }] }, { text: "fait" }];
    core.providers.client = () => client;
    core.settings.set("autoTitle", false);
    await new Promise<void>((resolve) => {
      const hooks: AgentHooks = { emit: (e) => e.type === "done" && resolve(), approve: async () => true, ...(clarify ? { clarify } : {}) };
      void core.submit(s.id, "choisis", hooks);
    });
    return core.messages.list(s.id).find((m) => m.role === "tool" && m.toolName === "ask_user")!;
  };

  it("la réponse de l'utilisateur revient au modèle comme résultat de l'outil", async () => {
    const asked: unknown[] = [];
    const m = await turn(async (sid, q) => (asked.push([sid.length > 0, q]), "src"));
    expect(asked).toEqual([[true, { question: "Quel dossier ?", choices: ["docs", "src"] }]]);
    expect(m.content).toBe("Réponse de l'utilisateur : src");
    expect(m.isError ?? false).toBe(false);
  });

  it("sans interface pour répondre (tâche planifiée, messagerie), le modèle l'apprend au lieu d'attendre", async () => {
    const m = await turn();
    expect(m.content).toMatch(/Personne ne peut répondre/);
  });
});
