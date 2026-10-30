// Lot 4 (30/10) : les nouveaux outils sont bien enregistrés dans le noyau réel, et l'agenda vit dans la base chiffrée du profil.
import { describe, expect, it } from "vitest";
import { makeCore } from "./helpers.js";

describe("lot 4 dans le noyau", () => {
  it("agenda : ajouter, lister, supprimer (base réelle)", async () => {
    const core = await makeCore();
    const agenda = core.tools.get("agenda")!;
    const ctx = { sessionId: "s", workspace: null };
    const added = await agenda.run({ action: "add", title: "Dentiste", start: "2099-01-15 09:30", place: "Dakar" }, ctx);
    expect(added).toMatch(/Ajouté à l'agenda : Dentiste/);
    const id = /\(id (ev-[^)]+)\)/.exec(added)![1]!;
    expect(await agenda.run({ action: "list", from: "2099-01-15", days: 1 }, ctx)).toContain("Dentiste (Dakar)");
    expect(await agenda.run({ action: "delete", id }, ctx)).toBe("Événement supprimé.");
    expect(await agenda.run({ action: "list", from: "2099-01-15", days: 1 }, ctx)).toBe("Rien à l'agenda sur cette période.");
  });

  it("météo et débit sont des outils Internet (coupés avec l'interrupteur) ; le briefing ne l'est pas", async () => {
    const core = await makeCore();
    for (const n of ["weather", "internet_speed", "agenda", "folder_organize_plan", "briefing"]) expect(core.tools.get(n), n).toBeDefined();
    const { activePolicy, toolVerdict } = await import("@jarod/kernel/network");
    const offline = { ...activePolicy(), internet: false };
    expect(toolVerdict(offline, "weather").ok).toBe(false);
    expect(toolVerdict(offline, "internet_speed").ok).toBe(false);
    expect(toolVerdict(offline, "briefing").ok).toBe(true);
  });
});
