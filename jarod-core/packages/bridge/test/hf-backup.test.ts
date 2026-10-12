// Chantier 5b de SPECS-P5-MODELS.md, barre (5b-H), partie sauvegarde de profil (Q13-2, § 4) : le dossier des modèles est EXCLU de la sauvegarde. Un profil dont `modelsDir`
// pointe ailleurs n'embarque aucun fichier de ce dossier (`.gguf`, `.part`) ; `modelsDir` n'est qu'un chemin dans le réglage, jamais du contenu ; et, par précaution, un
// `.gguf` ou un `.part` qui se trouverait DANS le profil est exclu avec sa raison.
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { createProfileBackup, exclusionReason } from "../src/main/profile-backup.js";

afterEach(async () => {
  await cleanup();
});

const walkFiles = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
};

describe("(5b-H) sauvegarde de profil (Q13-2) et dossier des modèles", () => {
  it("un profil dont modelsDir pointe ailleurs : aucun fichier de ce dossier dans la sauvegarde, ni .gguf ni .part ni leurs octets", () => {
    const base = tempDir();
    const profileDir = join(base, "donnees", "profiles", "default");
    const models = join(base, "modeles", "acme__tiny-GGUF");
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(models, { recursive: true });
    writeFileSync(join(profileDir, "SOUL.md"), "âme");
    const MARKER = "OCTETS_DU_MODELE_JAMAIS_SAUVEGARDES";
    writeFileSync(join(models, "m.gguf"), MARKER.repeat(1000));
    writeFileSync(join(models, "m2.gguf.part"), MARKER.repeat(500));
    // le réglage ne porte que le chemin
    writeFileSync(join(profileDir, "reglage.json"), JSON.stringify({ localEngine: { modelsDir: models } }));
    const { dir, manifest } = createProfileBackup({
      profileDir,
      profile: "default",
      appVersion: "0.0.0-test",
      destParent: join(base, "sauvegardes"),
      encrypted: false,
      snapshot: (target) => {
        writeFileSync(target, "base");
        return { userVersion: 1 };
      },
    });
    expect(manifest.files.map((f) => f.path).filter((p) => /\.(gguf|part)$/i.test(p))).toEqual([]);
    const onDisk = walkFiles(dir);
    expect(onDisk.filter((p) => /\.(gguf|part)$/i.test(p))).toEqual([]);
    for (const file of onDisk) expect(readFileSync(file, "utf8")).not.toContain(MARKER);
    // modelsDir lui-même n'est qu'un chemin dans le réglage sauvegardé
    const saved = onDisk.find((p) => p.endsWith("reglage.json"))!;
    expect(JSON.parse(readFileSync(saved, "utf8")).localEngine.modelsDir).toBe(models);
  });

  it("un .gguf ou un .part qui se trouverait dans le profil est exclu, avec sa raison écrite au manifeste", () => {
    const base = tempDir();
    const profileDir = join(base, "profil");
    mkdirSync(join(profileDir, "sous"), { recursive: true });
    writeFileSync(join(profileDir, "garde.txt"), "ok");
    writeFileSync(join(profileDir, "gros.gguf"), "x");
    writeFileSync(join(profileDir, "sous", "Autre.GGUF"), "x");
    writeFileSync(join(profileDir, "sous", "m.gguf.part"), "x");
    const { manifest } = createProfileBackup({
      profileDir,
      profile: "p",
      appVersion: "0",
      destParent: join(base, "out"),
      encrypted: false,
      snapshot: (t) => (writeFileSync(t, "b"), { userVersion: 1 }),
    });
    expect(manifest.files.map((f) => f.path)).toContain("profil/garde.txt");
    expect(manifest.files.map((f) => f.path).filter((p) => /gguf/i.test(p))).toEqual([]);
    const excluded = manifest.excluded.filter((e) => /gguf/i.test(e.path));
    expect(excluded.map((e) => e.path).sort()).toEqual(["gros.gguf", "sous/Autre.GGUF", "sous/m.gguf.part"]);
    expect(excluded.every((e) => /GGUF|modèle/i.test(e.reason))).toBe(true);
  });

  it("exclusionReason : seuls les FICHIERS .gguf / .gguf.part (insensible à la casse) ; un dossier de ce nom n'est pas un modèle", () => {
    expect(exclusionReason("a.gguf", false)).toMatch(/GGUF|modèle/i);
    expect(exclusionReason("a.GGUF.part", false)).toMatch(/GGUF|modèle/i);
    expect(exclusionReason("a.gguf", true)).toBeNull();
    expect(exclusionReason("notes.txt", false)).toBeNull();
    expect(exclusionReason("a.gguf.bak", false)).toBeNull();
  });
});
