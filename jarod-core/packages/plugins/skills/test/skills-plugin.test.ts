// plugin-skills : dataDir `<profil>/skills/<id>/SKILL.md` identique à Jarod-One (services/skills.ts:128-130).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";

afterEach(cleanup);

describe("plugin-skills", () => {
  it("au premier démarrage, écrit les exemples et les charge avant que le kernel soit prêt", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, skills: {} });
    expect(
      app.skills
        .list()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["resume-document", "revue-de-code"]);
  });

  it("découvre une skill déposée dans le dossier du profil", async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, "skills", "ma-skill"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "ma-skill", "SKILL.md"), "---\nname: Ma skill\ndescription: test\n---\nCorps");
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, skills: {} });
    expect(app.skills.get("ma-skill")).toMatchObject({ name: "Ma skill", description: "test" });
  });

  it("Q2 : une skill rangée par catégorie (format Hermes) est chargée au démarrage, id = dossier feuille", async () => {
    const dataDir = tempDir();
    mkdirSync(join(dataDir, "skills", "creative", "ascii-art"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "creative", "ascii-art", "SKILL.md"), "---\nname: ascii\ndescription: d\n---\nx");
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, skills: {} });
    expect(app.skills.get("ascii-art")).toMatchObject({ name: "ascii", description: "d", body: "x" });
    expect(app.skills.get("creative")).toBeUndefined();
  });
});
