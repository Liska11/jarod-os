/**
 * « Tout autoriser » : le bouton global, réversible.
 *
 * Le canal `tools-allow-all` n'a qu'une décision à prendre, isolée ici pour être testée sans noyau : ce que le patch écrit quand on
 * allume (profil Personnalisé + interrupteur, la seule combinaison qui lève les limites dures) et quand on éteint (interrupteur
 * retombé, profil d'avant rendu). La confirmation native qui précède l'allumage est celle du shell, testée côté renderer.
 */
import { JAROD_INVOKE_CHANNELS } from "@jarod/contracts/ipc";
import { describe, expect, it } from "vitest";
import { allowAllPatch } from "../src/main/handlers/jarod-settings.js";

describe("tout autoriser — le patch du bouton global", () => {
  it("le canal est autorisé par la passerelle (liste blanche des canaux)", () => {
    expect([...JAROD_INVOKE_CHANNELS]).toContain("tools-allow-all");
  });

  it("allumer : profil Personnalisé + interrupteur « sans demander »", () => {
    expect(allowAllPatch(true)).toEqual({ accessProfile: "custom", autoApproveTools: true });
  });

  it("éteindre : l'interrupteur retombe et le profil d'avant revient", () => {
    expect(allowAllPatch(false, "full")).toEqual({ autoApproveTools: false, accessProfile: "full" });
    expect(allowAllPatch(false, "approve")).toEqual({ autoApproveTools: false, accessProfile: "approve" });
    expect(allowAllPatch(false, "ask")).toEqual({ autoApproveTools: false, accessProfile: "ask" });
  });

  it("éteindre sans profil mémorisé, ou avec une valeur inconnue : « Plein »", () => {
    expect(allowAllPatch(false)).toEqual({ autoApproveTools: false, accessProfile: "full" });
    expect(allowAllPatch(false, "n'importe quoi")).toEqual({ autoApproveTools: false, accessProfile: "full" });
    expect(allowAllPatch(false, 42)).toEqual({ autoApproveTools: false, accessProfile: "full" });
  });
});
