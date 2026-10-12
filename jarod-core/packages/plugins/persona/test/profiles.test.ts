// Portage de packages/core/test/extensions.test.ts:140-… (rév. 2e180305) — bloc « profiles » (ProfileManager).
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileManager } from "../src/profiles.js";

afterEach(cleanup);

describe("profiles", () => {
  // extensions.test.ts:141-150
  it("creates, switches and isolates profiles", () => {
    const root = tempDir();
    const pm = new ProfileManager(root);
    expect(pm.list()).toEqual(["default"]);
    expect(pm.create("Travail Pro")).toBe("travail-pro");
    pm.setActive("travail-pro");
    expect(new ProfileManager(root).active()).toBe("travail-pro");
    expect(() => pm.create("travail pro")).toThrow(/existe/);
    expect(() => pm.setActive("inconnu")).toThrow();
  });
  // extensions.test.ts:152-189
  it("un nom de profil non conforme ne traverse pas : c'est un REFUS, pas un chemin", () => {
    const root = tempDir();
    const pm = new ProfileManager(root);
    expect(pm.create("Travail Pro")).toBe("travail-pro");
    const legitime = pm.dirFor("travail-pro");

    // Les noms VALIDES rendent exactement ce qu'ils rendaient : le dossier du profil, sous la racine.
    expect(legitime).toBe(join(root, "profiles", "travail-pro"));
    expect(pm.dirFor(pm.active())).toBe(join(root, "profiles", "default"));

    // Ce qui traversait avant : une remontée, un sous-dossier, un chemin absolu — et le vide, qui
    // rendait le dossier des profils lui-même. Chacun est refusé POUR ÇA.
    const dehors = join(root, "ailleurs");
    mkdirSync(dehors, { recursive: true });
    for (const hostile of [
      "..",
      "../ailleurs",
      "..\\ailleurs",
      "travail-pro/../..",
      "ailleurs/sous",
      join(dehors, "sous"),
      join(root, "profiles", "travail-pro"),
      "",
      "   ",
      ".",
    ]) {
      expect(() => pm.dirFor(hostile)).toThrow(/Nom de profil invalide/);
    }
    // Et le refus n'a rien ouvert ni rien créé au passage.
    expect(existsSync(join(dehors, "sous"))).toBe(false);
    expect(pm.list()).toEqual(["default", "travail-pro"]);

    // Un dossier posé à la MAIN (nom hors slug, mais profil réel) reste ouvrable : `list()` le nomme,
    // donc son nom doit continuer de désigner son dossier — c'est le comportement d'avant.
    mkdirSync(join(root, "profiles", "Mon Profil"), { recursive: true });
    expect(pm.list()).toContain("Mon Profil");
    expect(pm.dirFor("Mon Profil")).toBe(join(root, "profiles", "Mon Profil"));
  });
});
