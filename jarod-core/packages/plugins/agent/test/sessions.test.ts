// Portage de packages/core/test/sessions.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { ftsQuery } from "@jarod/plugin-storage";
import { makeCore, tempDir } from "./helpers.js";

describe("sessions & messages", () => {
  it("creates, lists (pinned first), renames and deletes sessions", async () => {
    const { sessions } = await makeCore();
    const a = sessions.create("Alpha");
    const b = sessions.create("Beta");
    sessions.setPinned(a.id, true);
    expect(sessions.list().map((s) => s.title)).toEqual(["Alpha", "Beta"]);
    sessions.rename(b.id, "Gamma");
    expect(sessions.get(b.id)?.title).toBe("Gamma");
    sessions.delete(a.id);
    expect(sessions.list()).toHaveLength(1);
  });

  it("stores messages with tool calls and cascades on delete", async () => {
    const { sessions, messages } = await makeCore();
    const s = sessions.create();
    messages.add(s.id, { role: "user", content: "salut" });
    messages.add(s.id, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }],
      raw: [{ type: "text" }],
    });
    messages.add(s.id, { role: "tool", content: "ok", toolCallId: "c1", toolName: "read_file" });
    const list = messages.list(s.id);
    expect(list.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(list[1]!.toolCalls?.[0]?.args).toEqual({ path: "a" });
    expect(list[1]!.raw).toEqual([{ type: "text" }]);
    expect(sessions.get(s.id)?.messageCount).toBe(3);
    sessions.delete(s.id);
    expect(messages.list(s.id)).toHaveLength(0);
  });

  it("full-text searches message bodies (accent-insensitive, prefix) and titles", async () => {
    const { sessions, messages } = await makeCore();
    const s1 = sessions.create("Recettes");
    const s2 = sessions.create("Travail");
    messages.add(s1.id, { role: "user", content: "Comment réussir une crème brûlée ?" });
    messages.add(s2.id, { role: "user", content: "Prépare la facture de septembre" });
    expect(sessions.search("creme").map((h) => h.sessionId)).toEqual([s1.id]);
    expect(sessions.search("fact")[0]?.snippet).toContain("[facture]");
    expect(sessions.search("recet").map((h) => h.sessionId)).toEqual([s1.id]);
    expect(sessions.search("   ")).toEqual([]);
    // FTS syntax characters must not throw
    expect(() => sessions.search('"AND OR (*')).not.toThrow();
  });

  it("truncates after the last user message (retry) and undoes a turn", async () => {
    const { sessions, messages } = await makeCore();
    const s = sessions.create();
    messages.add(s.id, { role: "user", content: "q1" });
    messages.add(s.id, { role: "assistant", content: "a1" });
    messages.add(s.id, { role: "user", content: "q2" });
    messages.add(s.id, { role: "assistant", content: "a2", inputTokens: 10, outputTokens: 5 });
    expect(messages.truncateAfterLastUser(s.id)?.content).toBe("q2");
    expect(messages.list(s.id).map((m) => m.content)).toEqual(["q1", "a1", "q2"]);
    expect(messages.undoLastTurn(s.id)).toBe("q2");
    expect(messages.list(s.id).map((m) => m.content)).toEqual(["q1", "a1"]);
  });

  it("Q10 : épingle du modèle — écrite, gardée par les mises à jour de contexte qui ne la nomment pas, relue après redémarrage", async () => {
    const dataDir = tempDir();
    const core = await makeCore({ dataDir });
    const s = core.sessions.create("Épinglée");
    core.updateSessionContext(s.id, { provider: "custom", model: "m-epingle", modelPinned: true });
    core.updateSessionContext(s.id, { workspace: dataDir }); // ne nomme pas l'épingle : inchangée
    expect(core.sessions.get(s.id)!.context).toMatchObject({ model: "m-epingle", modelPinned: true, workspace: dataDir });
    const t = core.sessions.create("Libre");
    core.updateSessionContext(t.id, { provider: "custom", model: "m-actif" });
    expect(core.sessions.get(t.id)!.context!.modelPinned).toBeUndefined();
    await core.dispose();
    const again = await makeCore({ dataDir });
    expect(again.sessions.get(s.id)!.context).toMatchObject({ provider: "custom", model: "m-epingle", modelPinned: true });
    again.updateSessionContext(s.id, { modelPinned: false });
    expect(again.sessions.get(s.id)!.context).toMatchObject({ model: "m-epingle" });
    expect(again.sessions.get(s.id)!.context!.modelPinned).toBeUndefined();
  });

  it("builds safe FTS queries", () => {
    expect(ftsQuery("hello world")).toBe('"hello"* "world"*');
    expect(ftsQuery("a b", "or")).toBe('"a"* OR "b"*');
    expect(ftsQuery("!!!")).toBeNull();
  });
});
