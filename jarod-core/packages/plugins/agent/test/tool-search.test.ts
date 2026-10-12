// Portage de packages/core/test/tool-search.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import type { AgentHooks } from "../src/agent.js";
import type { TestCore as JarodCore } from "./helpers.js";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import { rankTools } from "@jarod/plugin-tools";
import { makeCore } from "./helpers.js";

function fakeProvider(core: JarodCore, steps: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["m"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r: ChatResult = {
        text: "",
        thinking: "",
        toolCalls: [],
        stopReason: "end",
        inputTokens: 1,
        outputTokens: 1,
        ...(steps.shift() ?? { text: "fin" }),
      };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

function run(core: JarodCore, sessionId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    const hooks: AgentHooks = {
      emit: (e) => {
        if (e.type === "done") resolve();
      },
      approve: async () => true,
    };
    void core.submit(sessionId, text, hooks);
  });
}

const names = (req: ChatRequest) => req.tools.map((t) => t.name);

describe("tool search", () => {
  it("ranks tools by name first, then description", () => {
    const specs = [
      { name: "cronjob", description: "Crée une tâche planifiée", parameters: {} },
      { name: "github_issues", description: "Liste les tickets", parameters: {} },
      { name: "worktree_list", description: "Liste les copies (planifiée ailleurs)", parameters: {} },
    ];
    expect(rankTools("tâche planifiée", specs).map((t) => t.name)).toEqual(["cronjob", "worktree_list"]);
    expect(rankTools("github", specs).map((t) => t.name)).toEqual(["github_issues"]);
    expect(rankTools("", specs)).toEqual([]);
  });

  // Reporté (PHASE-1.md) : « offers a local model the core set… » (tool-search.test.ts source) dépend des familles d'outils github/rag/… — porté avec elles en Phase 2.

  it("sends every tool to a remote model, or when turned off, and never offers tool_search then", async () => {
    const core = await makeCore();
    await core.init();
    const s = core.sessions.create();
    let reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, s.id, "salut");
    expect(names(reqs[0]!)).toContain("cronjob");
    expect(names(reqs[0]!)).not.toContain("tool_search");
    expect(reqs[0]!.system).not.toContain("## Autres outils");

    core.settings.patch({ activeProvider: "lmstudio", activeModel: "m", toolSearch: "off" });
    reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    expect(names(reqs[0]!)).toContain("cronjob");

    core.settings.patch({ activeProvider: "anthropic", toolSearch: "on" });
    reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    expect(names(reqs[0]!)).toContain("tool_search");
    expect(names(reqs[0]!)).not.toContain("cronjob");
  });

  // Reporté (PHASE-1.md) : « tool_search by exact names… » (tool-search.test.ts source) dépend des familles d'outils github/rag/… — porté avec elles en Phase 2.

  // Incident du 2026-10-01 (12:03) : à « indexe X.xlsx » l'agent d'un modèle local n'a pas appelé rag_index (décrit seulement à la demande
  // en mode tool_search) ; il a cherché une compétence « rag_index », puis écrit ses propres scripts Python. Quand le RAG est allumé, les
  // deux outils RAG font partie du jeu de base offert d'emblée.
  it("RAG allumé : rag_search et rag_index sont offerts d'emblée à un modèle local (mode tool_search), sans passer par tool_search", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("rag", { ...core.settings.get("rag"), enabled: true });
    core.settings.patch({ activeProvider: "lmstudio", activeModel: "m", toolSearch: "auto" });
    const reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "indexe GSM-R_MATRICE_ESCALADE.xlsx");
    expect(names(reqs[0]!)).toContain("tool_search");
    expect(names(reqs[0]!)).toContain("rag_index");
    expect(names(reqs[0]!)).toContain("rag_search");
    expect(names(reqs[0]!)).not.toContain("cronjob"); // le reste du catalogue reste à la demande
    const others = (reqs[0]!.system.split("## Autres outils")[1] ?? "").split(",").map((x) => x.trim());
    expect(others).not.toContain("rag_index");
    expect(others).not.toContain("rag_search");
  });

  // § 19 (décision de l'utilisateur, remplace « à la demande, listés par nom ») : éteint, les outils RAG sont ABSENTS ; détail : rag-tools-offered.test.ts.
  it("RAG éteint : les outils RAG sont absents des outils ET du paragraphe « Autres outils » (§ 19)", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("rag", { ...core.settings.get("rag"), enabled: false });
    core.settings.patch({ activeProvider: "lmstudio", activeModel: "m", toolSearch: "auto" });
    const reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    expect(names(reqs[0]!)).not.toContain("rag_index");
    expect(names(reqs[0]!)).not.toContain("rag_search");
    expect(reqs[0]!.system).not.toContain("rag_index");
    expect(reqs[0]!.system).not.toContain("rag_search");
  });

  it("modèle distant (tous les outils) : inchangé, les outils RAG y sont déjà", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("rag", { ...core.settings.get("rag"), enabled: true });
    const reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    expect(names(reqs[0]!)).toContain("rag_index");
    expect(names(reqs[0]!)).toContain("cronjob");
  });
});
