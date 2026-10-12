/**
 * M5/M6 (audit v4 § 1) — deux états qui survivaient à ce qu'ils devaient couvrir.
 *
 * M5 : `runSchedule` écrit le mode imposé par la tâche dans le CONTEXTE de la conversation, et ne le
 * rétablissait que si un contexte existait déjà. Sur une conversation neuve (contexte épinglé paresseusement
 * par `settingsFor`), `previousMode` était absent : la conversation restait épinglée en « build » APRÈS la
 * tâche — une automation en `mode: "build"` changeait donc durablement le mode de l'utilisateur.
 *
 * M6 : la garde anti-boucle était UNE instance pour tout l'agent, et `reset()` n'était appelé nulle part.
 * Trois conversations faisant chacune UN seul appel identique recevaient « tu tournes en rond » à la
 * troisième, et deux conversations simultanées s'effaçaient mutuellement le compteur.
 */
import { describe, expect, it } from "vitest";
import { makeCore, tempDir } from "./helpers.js";

/** Un client de modèle piloté par le test : il demande un outil, puis conclut. */
function answer(
  core: Awaited<ReturnType<typeof makeCore>>,
  onChat?: (req: { messages: { role: string; content: string }[] }) => unknown,
) {
  core.providers.client = () =>
    ({
      chat: async (req: never) =>
        onChat?.(req as never) ?? { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" },
      listModels: async () => [],
    }) as never;
  core.settings.set("autoTitle", false);
}

describe("M5 — le mode imposé par une tâche ne reste pas collé à la conversation", () => {
  it("après une tâche en « build », la conversation revient au mode global (« plan »)", async () => {
    const core = await makeCore();
    answer(core);
    core.settings.patch({ agentMode: "plan" });
    const session = core.sessions.create();

    await core.runSchedule({
      id: "tache",
      name: "t",
      prompt: "p",
      spec: { kind: "once", at: 0 },
      sessionId: session.id,
      enabled: true,
      lastRun: null,
      nextRun: null,
      lastStatus: null,
      createdAt: 0,
      deliver: null,
      mode: "build",
    } as never);

    expect(core.sessions.get(session.id)?.context?.agentMode, "le mode global est rétabli").toBe("plan");
    await core.dispose();
  });

  it("le mode imposé EST appliqué pendant la tâche (le correctif ne l'annule pas)", async () => {
    const core = await makeCore();
    const seen: (string | undefined)[] = [];
    answer(core, () => {
      seen.push(core.sessions.get(core.sessions.list()[0]!.id)?.context?.agentMode);
      return { text: "ok", thinking: "", toolCalls: [], stopReason: "stop" };
    });
    core.settings.patch({ agentMode: "plan" });
    const session = core.sessions.create();

    await core.runSchedule({
      id: "tache",
      name: "t",
      prompt: "p",
      spec: { kind: "once", at: 0 },
      sessionId: session.id,
      enabled: true,
      lastRun: null,
      nextRun: null,
      lastStatus: null,
      createdAt: 0,
      deliver: null,
      mode: "build",
    } as never);

    expect(seen[0], "le tour s'exécute bien en build").toBe("build");
    await core.dispose();
  });
});

describe("M6 — la garde anti-boucle est par tour, jamais partagée", () => {
  it("trois conversations qui font chacune UN appel identique ne crient pas à la boucle", async () => {
    const core = await makeCore();
    const ws = tempDir();
    core.settings.patch({ workspace: ws, agentMode: "build" });
    const seen: string[] = [];
    answer(core, (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === "tool") {
        seen.push(last.content);
        return { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" };
      }
      return {
        text: "",
        thinking: "",
        toolCalls: [{ id: `c${Math.random()}`, name: "list_dir", args: { path: "." } }],
        stopReason: "tool_use",
      };
    });

    for (let i = 0; i < 3; i++)
      await core.runAndWait(core.sessions.create().id, "liste", { emit: () => {}, approve: async () => true });

    const flagged = seen.map((c) => c.includes("de suite avec exactement les mêmes arguments"));
    expect(flagged, "aucune conversation ne reçoit le rappel").toEqual([false, false, false]);
    await core.dispose();
  });

  it("dans UNE conversation, la répétition identique est bien signalée (le garde-fou reste vivant)", async () => {
    const core = await makeCore();
    const ws = tempDir();
    core.settings.patch({ workspace: ws, agentMode: "build" });
    const seen: string[] = [];
    let steps = 0;
    answer(core, (req) => {
      const last = req.messages[req.messages.length - 1]!;
      if (last.role === "tool") seen.push(last.content);
      if (steps++ >= 3) return { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" };
      return {
        text: "",
        thinking: "",
        toolCalls: [{ id: `c${steps}`, name: "list_dir", args: { path: "." } }],
        stopReason: "tool_use",
      };
    });

    await core.runAndWait(core.sessions.create().id, "liste", { emit: () => {}, approve: async () => true });

    expect(
      seen.some((c) => c.includes("de suite avec exactement les mêmes arguments")),
      "trois appels identiques dans le même tour : le rappel arrive",
    ).toBe(true);
    await core.dispose();
  });
});