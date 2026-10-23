// Chantier 5b de SPECS-P5-MODELS.md, barre (5b-H), partie pure : `validateModelsDir` — le dossier des modèles n'est JAMAIS sous le dossier de données du profil ni sous la
// racine des données (`dataRoot`), y compris après résolution des liens symboliques et des jonctions. Barres figées dans DECISIONS AVANT ce code.
import { join } from "node:path";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { validateModelsDir } from "../src/main/models-dir.js";

afterEach(async () => {
  await cleanup();
});

function layout() {
  const base = tempDir();
  const dataRoot = join(base, "donnees");
  const profileDir = join(dataRoot, "profiles", "default");
  const outside = join(base, "modeles");
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { base, dataRoot, profileDir, outside, ctx: { dataRoot, profileDir } };
}
const ok = (r: ReturnType<typeof validateModelsDir>) => (r.ok ? r.dir : `REFUS : ${r.reason}`);

describe("(5b-H) validateModelsDir", () => {
  it("un dossier hors du profil est accepté, rendu en chemin réel", () => {
    const { outside, ctx } = layout();
    const r = validateModelsDir(outside, ctx);
    expect(r.ok).toBe(true);
    // Chemin réel : sur la CI Windows, le dossier temporaire est un nom court (RUNNER~1) que la validation développe.
    if (r.ok) expect(r.dir.toLowerCase()).toBe(realpathSync.native(outside).toLowerCase());
  });

  it("refusé : le dossier de données du profil, la racine des données, et tout sous-dossier de l'un ou de l'autre — avec la raison", () => {
    const { dataRoot, profileDir, ctx } = layout();
    const deeper = join(profileDir, "sous", "dossier");
    mkdirSync(deeper, { recursive: true });
    const inRoot = join(dataRoot, "autre");
    mkdirSync(inRoot);
    for (const dir of [profileDir, dataRoot, deeper, inRoot]) {
      const r = validateModelsDir(dir, ctx);
      expect(r.ok, dir).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/profil|données/i);
    }
  });

  it("la casse ne contourne pas la règle sous Windows", () => {
    if (process.platform !== "win32") return;
    const { profileDir, ctx } = layout();
    expect(validateModelsDir(profileDir.toUpperCase(), ctx).ok).toBe(false);
    expect(validateModelsDir(profileDir.toLowerCase(), ctx).ok).toBe(false);
  });

  it("un lien (jonction) hors du profil qui POINTE sous le profil est refusé : c'est le chemin réel qui compte", () => {
    const { base, profileDir, ctx } = layout();
    const link = join(base, "raccourci");
    symlinkSync(profileDir, link, "junction");
    const r = validateModelsDir(link, ctx);
    expect(r.ok, ok(r)).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/profil|données/i);
  });

  it("un lien placé SOUS le profil est refusé même s'il pointe dehors : la règle porte sur le chemin CHOISI et sur le chemin RÉEL", () => {
    const { profileDir, outside, ctx } = layout();
    const link = join(profileDir, "vers-dehors");
    symlinkSync(outside, link, "junction");
    expect(validateModelsDir(link, ctx).ok).toBe(false);
  });

  it("refusé : inexistant, fichier, relatif, vide, non texte, caractère de contrôle, trop long", () => {
    const { base, ctx } = layout();
    const file = join(base, "fichier.txt");
    writeFileSync(file, "x");
    for (const dir of [join(base, "absent"), file, "relatif/dossier", "", 42, null, undefined, "C:\\a\u0000b", `${base}\\${"x".repeat(2000)}`] as unknown[]) {
      expect(validateModelsDir(dir, ctx).ok, String(dir)).toBe(false);
    }
  });

  it("un frère dont le nom commence pareil n'est pas « sous » le profil (donnees-2 n'est pas sous donnees)", () => {
    const { base, ctx } = layout();
    const sibling = join(base, "donnees-2");
    mkdirSync(sibling);
    expect(validateModelsDir(sibling, ctx).ok).toBe(true);
  });
});
