// SPECS-P5-UI-PARITE.md § 19, barre RT9 : `available` filtre `specs()` (relu à chaque appel) sans toucher `all()` ni `info()`.
import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolDef } from "../src/registry.js";

const def = (name: string, over: Partial<ToolDef> = {}): ToolDef => ({ name, description: `outil ${name}`, parameters: { type: "object", properties: {} }, source: "builtin", run: async () => "ok", ...over });

describe("ToolRegistry — available", () => {
  it("RT9 specs() filtre un outil dont available() est faux, relu à CHAQUE appel", () => {
    let on = false;
    const r = new ToolRegistry();
    r.register(def("libre"));
    r.register(def("lie", { available: () => on }));
    expect(r.specs([]).map((t) => t.name)).toEqual(["libre"]);
    on = true;
    expect(r.specs([]).map((t) => t.name)).toEqual(["libre", "lie"]);
    on = false;
    expect(r.specs([]).map((t) => t.name)).toEqual(["libre"]);
  });

  it("RT9 all() et info() listent toujours l'outil ; get() le rend ; disabledTools reste indépendant", () => {
    const r = new ToolRegistry();
    r.register(def("lie", { available: () => false }));
    r.register(def("autre"));
    expect(r.all().map((t) => t.name)).toEqual(["autre", "lie"]);
    expect(r.info([]).map((t) => [t.name, t.enabled])).toEqual([["autre", true], ["lie", true]]);
    expect(r.get("lie")).toBeDefined();
    expect(r.info(["lie"]).find((t) => t.name === "lie")?.enabled).toBe(false);
    expect(r.specs(["autre"]).map((t) => t.name)).toEqual([]);
  });

  it("RT9 un outil sans available n'est jamais filtré ; un available qui LÈVE vaut « absent » (fail-closed)", () => {
    const r = new ToolRegistry();
    r.register(def("a"));
    r.register(def("b", { available: () => { throw new Error("lecture impossible"); } }));
    expect(r.specs([]).map((t) => t.name)).toEqual(["a"]);
  });

  it("A4 info() dit pourquoi un outil n'est pas offert (limit), ou ce qui le réduit, relu à chaque appel", () => {
    let engine = false;
    const r = new ToolRegistry();
    r.register(def("libre"));
    r.register(def("bras", { available: () => engine, limit: () => (engine ? null : "Indisponible — moteur FlaUI introuvable") }));
    r.register(def("muet", { available: () => false }));
    r.register(def("yeux", { limit: () => "Vision désactivée — lecture du texte seulement" }));
    r.register(def("casse", { limit: () => { throw new Error("lecture impossible"); } }));
    const by = () => Object.fromEntries(r.info([]).map((t) => [t.name, t]));
    expect(by().libre).toMatchObject({ available: true, limit: null });
    expect(by().bras).toMatchObject({ available: false, limit: "Indisponible — moteur FlaUI introuvable" });
    expect(by().muet).toMatchObject({ available: false, limit: expect.stringMatching(/Indisponible/) });
    expect(by().yeux).toMatchObject({ available: true, limit: "Vision désactivée — lecture du texte seulement" });
    expect(by().casse).toMatchObject({ available: true, limit: null });
    engine = true;
    expect(by().bras).toMatchObject({ available: true, limit: null });
  });
});
