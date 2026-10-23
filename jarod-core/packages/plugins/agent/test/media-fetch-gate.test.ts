// G5 — raccordement de `media_fetch` (plugin integrations) à la porte réelle : Internet coupé = refus AVANT toute demande d'accord ;
// Internet allumé = accord demandé à chaque appel, la cible présentée est l'hôte ; refus de l'utilisateur = rien ne part.
import type { ChatRequest } from "@jarod/contracts";
import { DEFAULT_POLICY, setActivePolicy } from "@jarod/kernel/network";
import { bootApp, discoverPlugins } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { tempDir, testKeys } from "./helpers.js";

afterEach(() => setActivePolicy(null));

async function boot() {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [testKeys] };
  plugins.scheduler = { autoStart: false };
  const core = (await bootApp(plugins)).agent;
  core.settings.patch({ autoTitle: false, workspace: tempDir() });
  core.providers.client = () =>
    ({
      chat: async (req: ChatRequest) =>
        req.messages.some((m) => m.role === "tool")
          ? { text: "fini", thinking: "", toolCalls: [], stopReason: "stop" }
          : { text: "", thinking: "", toolCalls: [{ id: "t1", name: "media_fetch", args: { url: "https://video.example/watch?v=1", mode: "subtitles" } }], stopReason: "tool_use" },
      listModels: async () => [],
    }) as never;
  return core;
}

describe("G5 — media_fetch derrière la porte unique", () => {
  it("Internet coupé : refusé avant toute demande d'accord, et audité", async () => {
    setActivePolicy(() => ({ ...DEFAULT_POLICY, internet: false }));
    const core = await boot();
    const s = core.sessions.create();
    let asked = 0;
    await core.runAndWait(s.id, "sous-titres de cette vidéo", {
      emit: () => {},
      approve: async () => {
        asked++;
        return true;
      },
    });
    expect(asked).toBe(0);
    expect(core.messages.list(s.id).find((m) => m.role === "tool")).toMatchObject({ isError: true, content: expect.stringMatching(/Internet est désactivé/) });
    expect(core.auditLog(10).find((a) => a.tool === "media_fetch")).toMatchObject({ decision: "refusé (règle)" });
  });

  it("Internet allumé : l'accord est demandé ; refusé, rien ne part", async () => {
    setActivePolicy(() => ({ ...DEFAULT_POLICY, internet: true }));
    const core = await boot();
    const s = core.sessions.create();
    const asked: string[] = [];
    await core.runAndWait(s.id, "sous-titres de cette vidéo", {
      emit: () => {},
      approve: async (_sid, call) => {
        asked.push(call.name);
        return false;
      },
    });
    expect(asked).toEqual(["media_fetch"]);
    expect(core.messages.list(s.id).find((m) => m.role === "tool")).toMatchObject({ isError: true, content: expect.stringMatching(/refusé/) });
    expect(core.auditLog(10).find((a) => a.tool === "media_fetch")).toMatchObject({ decision: "refusé" });
  });
});
