// Jarod-cordis (Q18) : refine — SANK-AI `plugins/refine` (MIT), sur la mémoire de Jarod, historique dans le coffre.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResult, ProviderClient } from "@jarod/contracts";
import type { AgentEvent, AgentHooks } from "../src/agent.js";
import { REFINE_HISTORY_KEY, REFINE_HISTORY_MAX, RefineService } from "../src/refine.js";
import { makeCore, tempDir, type TestCore } from "./helpers.js";

function fakeProvider(core: TestCore, steps: Partial<ChatResult>[]): ChatRequest[] {
  const requests: ChatRequest[] = [];
  const client: ProviderClient = {
    listModels: async () => ["fake-1"],
    chat: async (req, h) => {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r: ChatResult = { text: "ok", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1, ...steps.shift() };
      if (r.text) h.onText?.(r.text);
      return r;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return requests;
}

function run(core: TestCore, sessionId: string, text: string) {
  const approvals: string[] = [];
  return new Promise<string[]>((resolve) => {
    const hooks: AgentHooks = {
      emit: (e: AgentEvent) => e.type === "done" && resolve(approvals),
      approve: async (_s, call) => {
        approvals.push(call.name);
        return true;
      },
    };
    void core.submit(sessionId, text, hooks);
  });
}

const service = (core: TestCore) => new RefineService(core.memory, core.settings);

describe("refine (Q18)", () => {
  it("ajout / modification / suppression journalisés ; chaque retour arrière remet l'état d'avant", async () => {
    const core = await makeCore();
    const r = service(core);
    const added = r.apply({ op: "add", content: "Préfère pnpm", type: "preference", evidence: "l'utilisateur l'a dit" })!;
    const kept = core.memory.add("Projet : Jarod");
    r.apply({ op: "update", id: kept.id, content: "Projet : Jarod-cordis", evidence: "renommé le 2026-09-28" });
    r.apply({ op: "delete", id: added.id, evidence: "contredit par l'utilisateur" });
    expect(r.history().map((e) => e.op)).toEqual(["add", "update", "delete"]);
    expect(core.memory.get(added.id)).toBeUndefined();

    expect(r.rollback().note).toBe(`souvenir recréé (nouvel id ${core.memory.list().find((m) => m.content === "Préfère pnpm")!.id})`);
    expect(r.rollback().note).toBe("souvenir remis dans son état d'avant");
    expect(core.memory.get(kept.id)?.content).toBe("Projet : Jarod");
    expect(r.rollback(0).note).toBe("souvenir ajouté retiré");
    expect(core.memory.list().some((m) => m.content === "Préfère pnpm" && m.type === "preference")).toBe(true); // la recréation reste
    expect(r.history().every((e) => e.rolledBackAt)).toBe(true);
    expect(() => r.rollback()).toThrow(/Index hors bornes/);
    expect(() => r.rollback(1)).toThrow(/déjà annulée/);
  });

  it("preuve obligatoire ; ajout identique à un souvenir existant = rien (et rien à annuler) ; id inconnu refusé", async () => {
    const core = await makeCore();
    const r = service(core);
    expect(() => r.apply({ op: "add", content: "x", evidence: "  " })).toThrow(/Preuve obligatoire/);
    core.memory.add("déjà là");
    expect(r.apply({ op: "add", content: "déjà là", evidence: "e" })).toBeNull();
    expect(r.history()).toEqual([]);
    expect(() => r.apply({ op: "update", id: "nope", content: "y", evidence: "e" })).toThrow(/introuvable/);
    expect(() => r.apply({ op: "rewrite", evidence: "e" })).toThrow(/Opération inconnue/);
  });

  it("borne atteinte : le plus ancien est évincé (le souvenir reste tel quel, plus annulable) ; les index se décalent", async () => {
    const core = await makeCore();
    const r = service(core);
    const first = r.apply({ op: "add", content: "souvenir-0", evidence: "e" })!;
    for (let i = 1; i <= REFINE_HISTORY_MAX; i++) r.apply({ op: "add", content: `souvenir-${i}`, evidence: "e" });
    const h = r.history();
    expect(h).toHaveLength(REFINE_HISTORY_MAX);
    expect(h.some((e) => e.id === first.id)).toBe(false);
    expect(h[0]!.after?.content).toBe("souvenir-1");
    expect(core.memory.get(first.id)?.content).toBe("souvenir-0");
    expect(r.rollback(0).entry.after?.content).toBe("souvenir-1");
  });

  it("outil à approbation ; persona et SOUL.md intacts ; historique dans le coffre, jamais en clair à côté de la base", async () => {
    const dataDir = tempDir();
    const core = await makeCore({ dataDir });
    const personaBefore = core.persona?.read() ?? "";
    const settingBefore = core.settings.get("persona");
    const s = core.sessions.create();
    fakeProvider(core, [
      { toolCalls: [{ id: "1", name: "refine", args: { op: "add", content: "Aime les tests QX-7731", evidence: "preuve-QX-7731" } }] },
      { text: "noté" },
    ]);
    expect(await run(core, s.id, "retiens")).toEqual(["refine"]);
    const tool = core.messages.list(s.id).find((m) => m.role === "tool")!;
    expect(tool.content).toMatch(/^ok : refine add \(.+\) appliqué et journalisé \(entrée 0\)/);
    expect(core.persona?.read() ?? "").toBe(personaBefore);
    expect(core.settings.get("persona")).toBe(settingBefore);
    expect(core.settings.secretKeys()).toContain(REFINE_HISTORY_KEY);
    // Aucun fichier du profil hors base ne contient la preuve.
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const leaks = walk(dataDir)
      .filter((f) => !/jarod\.db(-wal|-shm)?$/.test(f))
      .filter((f) => readFileSync(f).includes("preuve-QX-7731"));
    expect(leaks).toEqual([]);
    expect(core.tools.get("refine")?.dangerous).toBe(true);
    expect(core.tools.get("refine_rollback")?.dangerous).toBe(true);
  });

  it("absent en mode Plan et chez les sous-agents", async () => {
    const core = await makeCore();
    core.settings.set("agentMode", "plan");
    const s = core.sessions.create();
    const reqs = fakeProvider(core, [{}, { text: "compte rendu" }]);
    await run(core, s.id, "x");
    expect(reqs[0]!.tools.map((t) => t.name)).not.toContain("refine");
    await core.agent.runSubAgent("t", new AbortController().signal, s.id);
    expect(reqs[1]!.tools.map((t) => t.name)).not.toContain("refine");
  });
});
