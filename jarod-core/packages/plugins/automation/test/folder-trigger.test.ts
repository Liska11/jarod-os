// Déclencheur « dossier » (analyse du 29/10, idée de Jarvisol `watch_folder_service.dart`) : un nouveau fichier fini d'écrire lance les
// actions UNE fois, avec son chemin dans le prompt ; filtre d'extensions ; dossier absent ou relatif = rien.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOLDER_STABLE_MS, newFolderFiles, promptForFile } from "../src/automation.js";
import { makeCore, tempDir, testKeys } from "./helpers.js";

const at = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);

describe("newFolderFiles", () => {
  it("garde les fichiers arrivés depuis `since`, finis d'écrire, filtrés par extension, du plus ancien au plus récent", () => {
    const dir = tempDir();
    const now = Date.now();
    const old = join(dir, "ancien.wav");
    const a = join(dir, "a.wav");
    const b = join(dir, "b.WAV");
    const txt = join(dir, "note.txt");
    const fresh = join(dir, "en-cours.wav");
    for (const f of [old, a, b, txt, fresh]) writeFileSync(f, "x");
    mkdirSync(join(dir, "sous-dossier.wav"));
    at(old, now - 120_000);
    at(a, now - 30_000);
    at(b, now - 20_000);
    at(txt, now - 20_000);
    at(fresh, now - 1_000);
    const got = newFolderFiles({ kind: "folder", folder: dir, extensions: ["wav"] }, now - 60_000, now).map((f) => f.path);
    expect(got).toEqual([a, b]);
  });

  it("dossier relatif, absent ou non renseigné : aucun fichier, aucune erreur", () => {
    const now = Date.now();
    expect(newFolderFiles({ kind: "folder", folder: "relatif" }, 0, now)).toEqual([]);
    expect(newFolderFiles({ kind: "folder", folder: join(tempDir(), "absent") }, 0, now)).toEqual([]);
    expect(newFolderFiles({ kind: "folder" }, 0, now)).toEqual([]);
    expect(FOLDER_STABLE_MS).toBeGreaterThan(0);
  });
});

describe("promptForFile", () => {
  it("remplace {fichier}, sinon ajoute le chemin à la fin", () => {
    expect(promptForFile("Transcris {fichier} puis range {fichier}", "D:\\in\\a.wav")).toBe("Transcris D:\\in\\a.wav puis range D:\\in\\a.wav");
    expect(promptForFile("Résume ce document", "D:\\in\\r.pdf")).toBe("Résume ce document\n\nFichier : D:\\in\\r.pdf");
  });
});

describe("règle « dossier » : une exécution par fichier", () => {
  it("chaque fichier lance l'action une fois, même avec la même date ; le chemin arrive dans le prompt", async () => {
    const core = await makeCore({ dataDir: tempDir(), keyStores: [testKeys] });
    const rule = core.automation.create({ name: "inbox", trigger: { kind: "folder", folder: tempDir() }, actions: [{ type: "agent", prompt: "Transcris {fichier}" }] });
    await core.automation.executeRuleAt(rule, 1000, "D:\\in\\a.wav");
    await core.automation.executeRuleAt(rule, 1000, "D:\\in\\b.wav");
    await core.automation.executeRuleAt(rule, 1000, "D:\\in\\a.wav");
    expect(core.schedules.map((s) => s.prompt)).toEqual(["Transcris D:\\in\\a.wav", "Transcris D:\\in\\b.wav"]);
    await core.dispose();
  });
});
