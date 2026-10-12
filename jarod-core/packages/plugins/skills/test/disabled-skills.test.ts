// SPECS-P5-DISABLED-SKILLS.md § 5 — barres DS1-DS3 (core) ; DS4 est celle de la liste blanche
// de portabilité (testée dans plugin-memory), DS5-DS6 (UI) dans desktop. Une skill désactivée
// n'est PAS supprimée : elle reste lisible (`get`), mais n'est plus OFFERTE au modèle
// (`enabled()`, `promptSection()`) — effet immédiat à l'écriture du réglage, sans redémarrage
// (DS3). Le refus de `load_skill` appartient à plugin-tools (dépend de ce paquet, pas l'inverse).
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

/**
 * Deux boots sur la MÊME base : le réglage est posé AVANT le premier chargement des skills,
 * comme le ferait une session précédente (c'est la lecture au boot que DS1/DS2 vérifient).
 */
async function bootWith(disabled: string[]) {
  const dataDir = tempDir();
  const prep = await bootApp({ storage: { dataDir, encryptDb: false } });
  prep.storage.settings.set("disabledSkills", disabled);
  await shutdown(prep);
  const app = await bootApp({ storage: { dataDir, encryptDb: false }, skills: {} });
  return app;
}

describe("disabledSkills — core", () => {
  it("DS1 : disabledSkills [] (défaut) → toutes les skills chargées", async () => {
    const app = await bootWith([]);
    expect(app.skills.list().map((s) => s.id).sort()).toEqual(["resume-document", "revue-de-code"]);
    expect(app.skills.enabled().map((s) => s.id).sort()).toEqual(["resume-document", "revue-de-code"]);
    expect(app.skills.promptSection()).toContain("resume-document");
    expect(app.skills.promptSection()).toContain("revue-de-code");
  });

  it("DS2 : disabledSkills [« revue-de-code »] → absente de l'offre au modèle, présente dans l'inventaire", async () => {
    const app = await bootWith(["revue-de-code"]);
    // L'inventaire la montre (l'écran des skills doit pouvoir basculer) :
    expect(app.skills.list().map((s) => s.id).sort()).toEqual(["resume-document", "revue-de-code"]);
    expect(app.skills.get("revue-de-code")).toMatchObject({ enabled: false });
    // Mais elle n'est plus offerte au modèle :
    expect(app.skills.enabled().map((s) => s.id)).toEqual(["resume-document"]);
    expect(app.skills.promptSection()).not.toContain("revue-de-code");
    expect(app.skills.promptSection()).toContain("resume-document");
  });

  it("DS3 : patch({ disabledSkills }) → effet IMMÉDIAT, sans redémarrage ni rechargement de fichiers", async () => {
    const app = await bootWith([]);
    expect(app.skills.enabled().length).toBe(2);

    app.storage.settings.patch({ disabledSkills: ["resume-document"] });

    // Synchrone : pas de await entre l'écriture et l'effet — pas de fenêtre où la skill est « à moitié ».
    expect(app.skills.enabled().map((s) => s.id)).toEqual(["revue-de-code"]);
    expect(app.skills.promptSection()).not.toContain("resume-document");

    // Réactivation par le même chemin.
    app.storage.settings.patch({ disabledSkills: [] });
    expect(app.skills.enabled().length).toBe(2);
    expect(app.skills.promptSection()).toContain("resume-document");
  });
});
