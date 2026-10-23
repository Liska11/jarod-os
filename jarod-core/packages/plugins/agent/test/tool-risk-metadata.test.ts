// 2026-10-22 — le risque d'un outil est déclaré, jamais accordé par omission : un outil sans `dangerous` hors de la liste revue est tenu pour
// dangereux (accord demandé), et aucun outil intégré de Jarod ne s'appuie sur ce repli.
import { describe, expect, it } from "vitest";
import { REVIEWED_WITHOUT_APPROVAL, ToolRegistry, type ToolDef } from "@jarod/plugin-tools";
import { makeCore } from "./helpers.js";

const def = (name: string, over: Partial<ToolDef> = {}): ToolDef => ({ name, description: "x", parameters: { type: "object", properties: {} }, source: "builtin", run: async () => "ok", ...over });

describe("registre d'outils — métadonnées de risque", () => {
  it("un outil NOUVEAU qui ne déclare pas son risque est tenu pour dangereux", () => {
    const r = new ToolRegistry();
    const t = def("nouvel_outil_sans_risque");
    r.register(t);
    expect(r.get("nouvel_outil_sans_risque")?.dangerous).toBe(true);
    expect(r.defaultedToDangerous).toEqual(["nouvel_outil_sans_risque"]);
  });

  it("un outil qui déclare `dangerous: false` explicitement le reste ; un outil de la liste revue garde son comportement", () => {
    const r = new ToolRegistry();
    r.register(def("lecture_declaree", { dangerous: false }));
    r.register(def("read_file"));
    expect(r.get("lecture_declaree")?.dangerous).toBe(false);
    expect(r.get("read_file")?.dangerous).toBeUndefined();
    expect(r.defaultedToDangerous).toEqual([]);
    expect(REVIEWED_WITHOUT_APPROVAL.has("read_file")).toBe(true);
    // Registered at run time by the gateway, so no unit boot sees it: it asks per operation through ctx.approve and is deliberately not `dangerous`
    // (a second, generic card would ask twice for the same action — found by the connected-browser e2e).
    expect(REVIEWED_WITHOUT_APPROVAL.has("connected_browser")).toBe(true);
  });

  it("refuse l'enregistrement d'un outil mal formé", () => {
    const r = new ToolRegistry();
    expect(() => r.register(def("ok_1", { description: "  " }))).toThrow(/description obligatoire/);
    expect(() => r.register(def("ok_2", { parameters: null as never }))).toThrow(/paramètres/);
    expect(() => r.register(def("ok_3", { source: "inconnue" as never }))).toThrow(/origine inconnue/);
    expect(() => r.register(def("ok_4", { run: undefined as never }))).toThrow(/run obligatoire/);
    expect(() => r.register(def("pas valide"))).toThrow(/Nom d'outil invalide/);
  });

  it("aucun outil intégré du noyau ne dépend du repli : tous déclarent leur risque ou figurent dans la liste revue", async () => {
    const core = await makeCore();
    expect(core.tools.defaultedToDangerous).toEqual([]);
  });
});
