// Portage de packages/core/test/audit.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import type { ChatRequest } from "@jarod/contracts";
import { makeCore, tempDir } from "./helpers.js";

/** A model that asks for one tool call, then answers « fini ». */
function oneToolCall(core: Awaited<ReturnType<typeof makeCore>>, name: string, args: Record<string, unknown>) {
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) => {
        // Depuis le DERNIER message de l'utilisateur : un second tour de la même conversation rappelle l'outil.
        const done = req.messages.slice(req.messages.map((m) => m.role).lastIndexOf("user")).some((m) => m.role === "tool");
        return done
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: [{ id: "t1", name, args }], stopReason: "tool_use" };
      },
      listModels: async () => [],
    }) as never;
  core.settings.set("autoTitle", false);
}

const turn = (core: Awaited<ReturnType<typeof makeCore>>, approve: boolean) =>
  core.runAndWait(core.sessions.create().id, "vas-y", { emit: () => {}, approve: async () => approve });

describe("le journal d'audit", () => {
  it("inscrit chaque action qui demande un accord : accordée, refusée, automatique, bloquée", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "write_file", { path: "note.txt", content: "bonjour" });

    await turn(core, true);
    await turn(core, false);
    core.settings.patch({ autoApproveTools: true });
    await turn(core, false);
    core.settings.patch({ agentMode: "plan" });
    await turn(core, true);

    const log = core.auditLog();
    expect(log.map((a) => [a.tool, a.decision, a.ok])).toEqual([
      ["write_file", "bloqué (mode Plan)", undefined],
      ["write_file", "automatique", true],
      ["write_file", "refusé", undefined],
      ["write_file", "accordé", true],
    ]);
    expect(log[3]!.args).toContain("note.txt");
    expect(typeof log[0]!.at).toBe("number");
  });

  it("AV2-009 : un secret dans les arguments d'un outil n'entre jamais dans le journal (masqué avant la troncature)", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    const cle = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    oneToolCall(core, "write_file", { path: "env.txt", content: `${"a".repeat(430)} OPENAI_API_KEY=${cle}` });
    await turn(core, true);
    const [line] = core.auditLog();
    expect(line!.args).not.toContain(cle);
    expect(line!.args).not.toContain("sk-abcdefghijkl"); // pas même un morceau coupé par la troncature
    expect(line!.args).toContain("env.txt");
  });

  it("2026-10-22 : un champ nommé comme un secret est masqué en entier, même court, et une option de ligne de commande aussi", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "write_file", { path: "a.txt", content: "x", password: "SENTINELLE-court", note: "mysql --password SENTINELLE-opt -h db" });
    await turn(core, true);
    const [line] = core.auditLog();
    expect(line!.args).not.toContain("SENTINELLE");
    expect(line!.args).toContain("a.txt");
    expect(line!.args).toContain("-h db");
  });

  it("V-02 : inscrit aussi les lectures, qui ne demandent rien, avec l'appel, le palier, la cible et la durée", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "list_dir", { path: "." });
    const r = await turn(core, true);
    expect(r.text).toBe("fini");
    const [line] = core.auditLog();
    expect(line).toMatchObject({ tool: "list_dir", decision: "sans accord", ok: true, callId: "t1", tier: "ordinaire" });
    expect(line!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("V-02 : une écriture accordée porte son palier, sa cible et sa preuve", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "write_file", { path: "trace.txt", content: "x" });
    await turn(core, true);
    expect(core.auditLog()[0]).toMatchObject({ tool: "write_file", decision: "accordé", ok: true, callId: "t1", tier: "sensible", target: expect.stringContaining("trace.txt") });
    expect(core.auditLog()[0]!.proof).toMatch(/^(verified|unverifiable)$/);
  });

  it("V-02 : un outil inconnu et des arguments hors schéma laissent une ligne « refusé (invalide) »", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "outil_qui_n_existe_pas", {});
    await turn(core, true);
    oneToolCall(core, "write_file", { content: 3 });
    await turn(core, true);
    expect(core.auditLog().map((a) => [a.tool, a.decision, a.tier])).toEqual([
      ["write_file", "refusé (invalide)", "sensible"],
      ["outil_qui_n_existe_pas", "refusé (invalide)", undefined],
    ]);
  });

  it("V-02 : une cible qui cite un secret est masquée dans la ligne", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "run_shell", { command: "mysql --password SENTINELLE-cible -h db" });
    await turn(core, false);
    const [line] = core.auditLog();
    expect(line).toMatchObject({ tool: "run_shell", decision: "refusé" });
    expect(line!.target).toContain("-h db");
    expect(JSON.stringify(line)).not.toContain("SENTINELLE");
  });

  it("V-02 : auditOf rend la timeline d'UNE conversation, dans l'ordre d'écriture", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "list_dir", { path: "." });
    const a = core.sessions.create().id;
    const b = core.sessions.create().id;
    await core.runAndWait(a, "vas-y", { emit: () => {}, approve: async () => true });
    await core.runAndWait(b, "vas-y", { emit: () => {}, approve: async () => true });
    await core.runAndWait(a, "encore", { emit: () => {}, approve: async () => true });
    const timeline = core.auditOf(a);
    expect(timeline).toHaveLength(2);
    expect(timeline.every((e) => e.sessionId === a)).toBe(true);
    expect(timeline[0]!.at).toBeLessThanOrEqual(timeline[1]!.at);
    expect(core.auditOf(b)).toHaveLength(1);
    expect(core.auditOf("inconnue")).toEqual([]);
  });
});
