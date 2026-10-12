// Portage de packages/core/test/audit.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import type { ChatRequest } from "@jarod/contracts";
import { makeCore, tempDir } from "./helpers.js";

/** A model that asks for one tool call, then answers « fini ». */
function oneToolCall(core: Awaited<ReturnType<typeof makeCore>>, name: string, args: Record<string, unknown>) {
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) => {
        const done = req.messages.some((m) => m.role === "tool");
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

  it("n'inscrit pas les lectures, qui ne demandent rien", async () => {
    const core = await makeCore();
    core.settings.patch({ workspace: tempDir() });
    oneToolCall(core, "list_dir", { path: "." });
    const r = await turn(core, true);
    expect(r.text).toBe("fini");
    // The read really ran (its result is in the conversation), and left no audit line.
    expect(core.auditLog()).toEqual([]);
  });
});
