// Plus de 128 outils dans une requête : DeepSeek et OpenAI répondent HTTP 400. Au-delà du seuil, la recherche d'outils prend le relais toute seule.
import { describe, expect, it } from "vitest";
import { MAX_TOOLS_PER_REQUEST } from "../src/agent.js";
import { makeCore } from "./helpers.js";

const extra = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `zz_extra_${i}`,
    description: "outil de test",
    parameters: { type: "object", properties: {} },
    source: "builtin" as const,
    dangerous: false,
    run: async () => "ok",
  }));

describe("limite d'outils par requête", () => {
  it("sous le seuil un fournisseur distant reçoit tous les outils ; au-dessus, la recherche d'outils s'active", async () => {
    const core = await makeCore();
    await core.init();
    core.settings.set("activeProvider", "anthropic");
    const s = () => core.settings.getAll();
    expect(core.agent.useToolSearch(s(), "anthropic")).toBe(false);

    const room = MAX_TOOLS_PER_REQUEST - core.agent.toolSpecs(s()).length;
    for (const t of extra(room + 5)) core.tools.register(t);
    expect(core.agent.toolSpecs(s()).length).toBeGreaterThan(MAX_TOOLS_PER_REQUEST);
    expect(core.agent.useToolSearch(s(), "anthropic")).toBe(true);

    const lean = core.agent.toolSpecs(s(), { sessionId: "x" });
    expect(lean.length).toBeLessThan(MAX_TOOLS_PER_REQUEST);
  });

  it("le réglage « off » reste respecté", async () => {
    const core = await makeCore();
    await core.init();
    for (const t of extra(MAX_TOOLS_PER_REQUEST + 5)) core.tools.register(t);
    core.settings.set("toolSearch", "off");
    expect(core.agent.useToolSearch(core.settings.getAll(), "anthropic")).toBe(false);
  });
});
