// AV2-007 — `ScheduleDto.mode` : un tour lancé par l'automation tourne dans le mode demandé, et la conversation
// retrouve son mode épinglé ensuite (le mode d'une tâche ne doit pas déteindre sur la conversation de l'utilisateur).
import type { ChatResult, ProviderClient } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { makeCore, type TestCore } from "./helpers.js";

/** Un modèle qui note le mode de la conversation PENDANT le tour. */
function observe(core: TestCore, sessionId: () => string): string[] {
  const seen: string[] = [];
  const client: ProviderClient = {
    listModels: async () => ["m"],
    chat: async () => {
      seen.push(core.sessions.get(sessionId())?.context?.agentMode ?? "?");
      return { text: "ok", thinking: "", toolCalls: [], stopReason: "end", inputTokens: 1, outputTokens: 1 } satisfies ChatResult;
    },
  };
  core.providers.client = () => client;
  core.settings.set("autoTitle", false);
  return seen;
}

describe("runSchedule : mode imposé pour ce tour seulement", () => {
  it("mode « plan » imposé à une conversation en build : le tour voit plan, puis build est rétabli", async () => {
    const core = await makeCore();
    const sid = core.sessions.create("conv").id;
    core.updateSessionContext(sid, { agentMode: "build" });
    const seen = observe(core, () => sid);
    const sch = core.scheduler.save({ name: "t", prompt: "go", spec: { kind: "interval", minutes: 60 } });
    await core.runSchedule({ ...sch, sessionId: sid, mode: "plan" });
    expect(seen).toEqual(["plan"]);
    expect(core.sessions.get(sid)!.context!.agentMode).toBe("build");
  });

  it("sans mode : la conversation garde son mode, rien n'est touché", async () => {
    const core = await makeCore();
    const sid = core.sessions.create("conv").id;
    core.updateSessionContext(sid, { agentMode: "plan" });
    const seen = observe(core, () => sid);
    const sch = core.scheduler.save({ name: "t", prompt: "go", spec: { kind: "interval", minutes: 60 } });
    await core.runSchedule({ ...sch, sessionId: sid });
    expect(seen).toEqual(["plan"]);
    expect(core.sessions.get(sid)!.context!.agentMode).toBe("plan");
  });
});
