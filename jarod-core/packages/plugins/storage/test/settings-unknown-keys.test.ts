/**
 * Audit D-09 : `SettingsService.patch` jetait EN SILENCE une clé absente de DEFAULT_SETTINGS. Elle reste écartée (compatibilité avec un profil
 * d'une autre version), mais le NOM est désormais dit — jamais la valeur — et les clés connues du même lot sont écrites.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCore } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("SettingsService.patch : clés inconnues", () => {
  it("écarte une clé inconnue en la NOMMANT (sans sa valeur) et écrit les clés connues du même lot", async () => {
    const core = await makeCore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const all = core.settings.patch({ activeModel: "m-x", cleInventee: "valeur-sensible" } as never);

    expect(all.activeModel).toBe("m-x");
    expect("cleInventee" in all).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("cleInventee");
    expect(String(warn.mock.calls[0]![0])).not.toContain("valeur-sensible");
  });

  it("aucun avertissement quand toutes les clés sont connues ou que le lot est vide", async () => {
    const core = await makeCore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    core.settings.patch({ activeModel: "m-y" });
    core.settings.patch({});

    expect(warn).not.toHaveBeenCalled();
  });
});
