// Mode « léger » (modèle local) : les outils de bureau et de vue d'écran sont offerts d'emblée, sans passer par tool_search.
import { describe, expect, it } from "vitest";
import { CORE_TOOLS, ToolSearchService } from "../src/tool-search.js";

const spec = (name: string) => ({ name, description: `outil ${name}`, parameters: { type: "object", properties: {} } });

describe("tool search — ensemble offert d'emblée", () => {
  it("les bras (desktop_windows, desktop_control) et les yeux (screen_look) en font partie", () => {
    for (const name of ["desktop_windows", "desktop_control", "screen_look"]) expect(CORE_TOOLS.has(name)).toBe(true);
  });

  it("lean() les offre sans activation ; un outil hors ensemble reste caché jusqu'à la recherche", () => {
    const svc = new ToolSearchService();
    const all = ["read_file", "desktop_windows", "desktop_control", "screen_look", "system_info"].map(spec);
    expect(svc.lean("s1", all).map((t) => t.name).sort()).toEqual(["desktop_control", "desktop_windows", "read_file", "screen_look"]);
    svc.activate("s1", ["system_info"]);
    expect(svc.lean("s1", all).map((t) => t.name)).toContain("system_info");
  });

  it("un outil de bureau absent du registre (moteur introuvable) n'apparaît pas : rien n'est inventé", () => {
    const svc = new ToolSearchService();
    expect(svc.lean("s2", ["read_file"].map(spec)).map((t) => t.name)).toEqual(["read_file"]);
  });
});
