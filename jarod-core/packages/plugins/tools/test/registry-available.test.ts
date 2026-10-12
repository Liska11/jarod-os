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
});
