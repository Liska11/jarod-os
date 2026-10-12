// Portage de packages/core/test/local-server-tool.test.ts (rév. 2e180305).
import { describe, expect, it } from "vitest";
import { builtinTools } from "../src/builtin.js";
import { makeCore } from "./helpers.js";

const ctx = {} as never;

describe("l'agent peut piloter le serveur local, et il dit pourquoi il refuse", () => {
  it("sans superviseur fourni, l'outil n'existe pas plutôt que d'exister vide", async () => {
    expect(builtinTools((await makeCore()).memory).some((t) => t.name === "local_model_server")).toBe(false);
  });

  it("est enregistré sur le cœur réel, avec l'approbation exigée", async () => {
    const core = await makeCore();
    const tool = core.tools.get("local_model_server");
    expect(tool?.dangerous).toBe(true);
  });

  it("status sans rien de lancé le dit, et stop ne fait rien", async () => {
    const core = await makeCore();
    const tool = core.tools.get("local_model_server")!;
    expect(await tool.run({ action: "status" }, ctx)).toBe("Aucun serveur lancé par Jarod.");
    expect(await tool.run({ action: "stop" }, ctx)).toMatch(/rien n'a été arrêté/);
    expect(await tool.run({ action: "n'importe quoi" }, ctx)).toMatch(/Action inconnue/);
  });

  it("start sans chemin rend un refus LISIBLE, pas une exception", async () => {
    const core = await makeCore();
    const tool = core.tools.get("local_model_server")!;
    expect(await tool.run({ action: "start", model: "m.gguf" }, ctx)).toMatch(/LLAMA_NO_BINARY/);
  });
});
