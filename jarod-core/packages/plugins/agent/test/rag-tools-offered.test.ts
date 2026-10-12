// SPECS-P5-UI-PARITE.md § 19 : interrupteur RAG éteint = outils `rag_search` / `rag_index` ABSENTS de la liste du modèle, de `tool_search`
// et d'un sous-agent ; allumé = présents ; relu à chaque étape. VRAI noyau, fournisseur scripté qui enregistre chaque requête.
import { describe, expect, it, vi } from "vitest";
import type { AgentHooks } from "../src/agent.js";
import type { TestCore as JarodCore } from "./helpers.js";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import { makeCore } from "./helpers.js";

const RAG = ["rag_search", "rag_index"] as const;

function fakeProvider(core: JarodCore, steps: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["m"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r: ChatResult = { text: "", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1, ...(steps.shift() ?? { text: "fin" }) };
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
    const hooks: AgentHooks = { emit: (e) => { if (e.type === "done") resolve(); }, approve: async () => true };
    void core.submit(sessionId, text, hooks);
  });
}

const setRag = (core: JarodCore, enabled: boolean) => core.settings.set("rag", { ...core.settings.get("rag"), enabled });
const local = (core: JarodCore) => core.settings.patch({ activeProvider: "lmstudio", activeModel: "m", toolSearch: "auto" });
const names = (req: ChatRequest) => req.tools.map((t) => t.name);
/** Les noms du paragraphe « Autres outils » du prompt système (ce que le modèle apprend sans description). */
const others = (req: ChatRequest) => (req.system.split("## Autres outils")[1] ?? "").split(/[\s,]+/).filter(Boolean);
const toolSearch = (core: JarodCore, args: Record<string, unknown>, sessionId = "s-ts") => core.tools.get("tool_search")!.run(args, { sessionId, workspace: null });

describe("§ 19 — les outils RAG suivent l'interrupteur", () => {
  it("RT1 mode léger, ÉTEINT : ni dans les outils ni dans « Autres outils » (et la liste n'est pas vide)", async () => {
    const core = await makeCore();
    await core.init();
    setRag(core, false);
    local(core);
    const reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    for (const n of RAG) {
      expect(names(reqs[0]!), `${n} dans les outils`).not.toContain(n);
      expect(others(reqs[0]!), `${n} dans « Autres outils »`).not.toContain(n);
    }
    expect(names(reqs[0]!)).toContain("tool_search");
    expect(names(reqs[0]!)).toContain("read_file");
    expect(others(reqs[0]!)).toContain("cronjob"); // le paragraphe existe et nomme bien les autres
  });

  it("RT2 mode complet (modèle distant), ÉTEINT : absents, mais le reste y est", async () => {
    const core = await makeCore();
    await core.init();
    setRag(core, false);
    const reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    for (const n of RAG) expect(names(reqs[0]!), n).not.toContain(n);
    expect(names(reqs[0]!)).toContain("cronjob");
    expect(names(reqs[0]!)).toContain("read_file");
  });

  it("RT3 ALLUMÉ : présents en mode complet, offerts d'emblée en mode léger (absents d'« Autres outils »)", async () => {
    const core = await makeCore();
    await core.init();
    setRag(core, true);
    let reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    for (const n of RAG) expect(names(reqs[0]!), `complet : ${n}`).toContain(n);
    local(core);
    reqs = fakeProvider(core, [{ text: "ok" }]);
    await run(core, core.sessions.create().id, "salut");
    for (const n of RAG) {
      expect(names(reqs[0]!), `léger : ${n}`).toContain(n);
      expect(others(reqs[0]!), `léger, « Autres outils » : ${n}`).not.toContain(n);
    }
    expect(names(reqs[0]!)).not.toContain("cronjob");
  });

  it("RT4 tool_search ÉTEINT : ni par nom ni par mot-clé, rien d'activé, absents de « Outils disponibles » ; ALLUMÉ (contrôle) : trouvés et activés", async () => {
    const core = await makeCore();
    await core.init();
    setRag(core, false);
    const byName = await toolSearch(core, { names: [...RAG] });
    expect(byName).toMatch(/Aucun outil trouvé/);
    for (const n of RAG) expect(byName, `« Outils disponibles » nomme ${n}`).not.toContain(n);
    for (const q of ["indexer des documents", "recherche sémantique dans les documents indexés"]) {
      const r = await toolSearch(core, { query: q });
      for (const n of RAG) expect(r, `requête « ${q} » : ${n}`).not.toContain(n);
    }
    for (const n of RAG) expect(core.app.tools.toolSearch.activeFor("s-ts").has(n), `activé : ${n}`).toBe(false);

    setRag(core, true);
    const found = await toolSearch(core, { names: [...RAG] });
    expect(found).toContain("Activés pour cette conversation");
    for (const n of RAG) expect(found).toContain(n);
    for (const n of RAG) expect(core.app.tools.toolSearch.activeFor("s-ts").has(n)).toBe(true);
  });

  it("RT5 même conversation : ÉTEINT → ALLUMÉ → ÉTEINT, relu à chaque étape ; l'activation par tool_search ne survit pas à l'extinction", async () => {
    const core = await makeCore();
    await core.init();
    local(core);
    const s = core.sessions.create();
    setRag(core, false);
    let reqs = fakeProvider(core, [{ text: "un" }]);
    await run(core, s.id, "premier tour");
    for (const n of RAG) expect(names(reqs[0]!), `1 éteint : ${n}`).not.toContain(n);

    setRag(core, true);
    reqs = fakeProvider(core, [{ toolCalls: [{ id: "a", name: "tool_search", args: { names: [...RAG] } }] }, { text: "deux" }]);
    await run(core, s.id, "deuxième tour");
    for (const n of RAG) {
      expect(names(reqs[0]!), `2 allumé, étape 1 : ${n}`).toContain(n);
      expect(names(reqs[1]!), `2 allumé, étape 2 : ${n}`).toContain(n);
    }

    setRag(core, false);
    reqs = fakeProvider(core, [{ text: "trois" }]);
    await run(core, s.id, "troisième tour");
    for (const n of RAG) {
      expect(names(reqs[0]!), `3 éteint : ${n}`).not.toContain(n);
      expect(others(reqs[0]!), `3 éteint, « Autres outils » : ${n}`).not.toContain(n);
    }
  });

  it("RT5 bis : la bascule vaut à l'étape SUIVANTE du même tour (éteint pendant le tour)", async () => {
    const core = await makeCore();
    await core.init();
    setRag(core, true);
    core.settings.patch({ workspace: "." });
    const s = core.sessions.create();
    const requests: ChatRequest[] = [];
    let step = 0;
    core.providers.client = () => ({
      listModels: async () => ["m"],
      chat: async (req, h) => {
        requests.push(structuredClone({ ...req, signal: undefined }));
        step++;
        if (step === 1) {
          setRag(core, false); // l'utilisateur éteint pendant que le modèle travaille
          return { text: "", thinking: "", toolCalls: [{ id: "x", name: "list_dir", args: { path: "." } }], stopReason: "tool_use", inputTokens: 1, outputTokens: 1 } as ChatResult;
        }
        h.onText?.("fin");
        return { text: "fin", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1 } as ChatResult;
      },
    });
    core.settings.set("autoTitle", false);
    await run(core, s.id, "liste");
    for (const n of RAG) {
      expect(names(requests[0]!), `étape 1 : ${n}`).toContain(n);
      expect(names(requests[1]!), `étape 2 : ${n}`).not.toContain(n);
    }
  });

  it("RT6 appelé quand même, ÉTEINT : l'outil tourne et rend le refus du service qui nomme le bon volet (rien d'indexé)", async () => {
    const core = await makeCore();
    await core.init();
    setRag(core, false);
    const s = core.sessions.create();
    fakeProvider(core, [{ toolCalls: [{ id: "r", name: "rag_search", args: { query: "alpha" } }] }, { text: "refusé" }]);
    await run(core, s.id, "cherche alpha");
    const tool = core.messages.list(s.id).find((m) => m.role === "tool")!;
    expect(tool.content).toContain("RAG local désactivé");
    expect(tool.content).toContain("Réglages › Documents");
    expect(core.app.rag.rag.status().chunks).toBe(0);
  });

  it("RT7 sous-agent : ÉTEINT, ses outils n'incluent pas les outils RAG ; ALLUMÉ, ils y sont", async () => {
    const core = await makeCore();
    await core.init();
    const s = core.sessions.create();
    setRag(core, false);
    let reqs = fakeProvider(core, [{ text: "rien" }]);
    await core.agent.runSubAgent("cherche", undefined, s.id);
    expect(names(reqs[0]!)).toContain("read_file"); // la liste n'est pas vide
    for (const n of RAG) expect(names(reqs[0]!), `éteint : ${n}`).not.toContain(n);
    setRag(core, true);
    reqs = fakeProvider(core, [{ text: "rien" }]);
    await core.agent.runSubAgent("cherche", undefined, s.id);
    for (const n of RAG) expect(names(reqs[0]!), `allumé : ${n}`).toContain(n);
  });

  it("RT8 fail-closed : une lecture du réglage qui LÈVE vaut « absent », sans faire planter le tour", async () => {
    const core = await makeCore();
    await core.init();
    const s = core.sessions.create();
    setRag(core, true);
    const reqs = fakeProvider(core, [{ text: "ok" }]);
    const real = core.app.storage.settings.get.bind(core.app.storage.settings);
    const spy = vi.spyOn(core.app.storage.settings, "get").mockImplementation(((key: string) => {
      if (key === "rag") throw new Error("lecture impossible");
      return real(key as never);
    }) as never);
    try {
      await run(core, s.id, "salut");
    } finally {
      spy.mockRestore();
    }
    for (const n of RAG) expect(names(reqs[0]!), n).not.toContain(n);
    expect(names(reqs[0]!)).toContain("read_file");
  });
});
