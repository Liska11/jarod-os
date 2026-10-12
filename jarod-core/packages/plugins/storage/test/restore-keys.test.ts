/**
 * Jarod-cordis (Q14) : restauration d'une sauvegarde complète dans un profil NEUF — la clé du profil d'origine
 * est retrouvée (jamais créée), adoptée par le nouveau dossier (jamais par-dessus une clé existante), et un
 * fichier de base isolé se contrôle avec elle sans écriture.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, shutdown } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { checkDbFile, MIGRATIONS } from "../src/db.js";
import { DbKeyError, memoryKeyStore } from "../src/dbkey.js";
import { tempDir } from "./helpers.js";

describe("Q14 — clés et contrôle pour la restauration", () => {
  it("findKey : clé d'un autre profil de ce compte, null si absente ; adoptKey : profil neuf seulement ; la copie s'ouvre avec la clé adoptée", async () => {
    const keys = memoryKeyStore();
    const origin = tempDir();
    const app = await bootApp({ storage: { dataDir: origin, keyStores: [keys] } });
    const storage = app.storage;
    storage.db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Gardée', 1, 1)");
    const snapshot = join(tempDir(), "copie.db");
    storage.db.snapshotTo(snapshot);

    const key = storage.findKey(origin);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.findKey(tempDir())).toBeNull(); // aucun profil : aucune clé, et aucune créée
    expect(checkDbFile(snapshot, key)).toEqual({ userVersion: MIGRATIONS.length });
    expect(() => checkDbFile(snapshot, "mauvaise")).toThrow(DbKeyError);
    expect(storage.checkDatabaseFile(snapshot, key)).toEqual({ userVersion: MIGRATIONS.length });

    // Profil neuf : la clé d'origine y est adoptée ; jamais par-dessus une clé existante (ni l'origine, ni deux fois).
    const restored = tempDir();
    mkdirSync(restored, { recursive: true });
    copyFileSync(snapshot, join(restored, "jarod.db"));
    expect(storage.adoptKey(restored, key!)).toBe("Mémoire (tests)");
    expect(() => storage.adoptKey(restored, key!)).toThrow(/déjà une clé/);
    expect(() => storage.adoptKey(origin, "autre")).toThrow(/déjà une clé/);
    expect(storage.findKey(origin)).toBe(key);
    await shutdown(app);

    // Le profil restauré s'ouvre par le chemin normal (resolveDbKey) avec la clé adoptée : données identiques.
    const reopened = await bootApp({ storage: { dataDir: restored, keyStores: [keys] } });
    expect(reopened.storage.db.all("SELECT id, title FROM sessions")).toEqual([{ id: "s1", title: "Gardée" }]);
    expect(reopened.storage.dbEncryption.encrypted).toBe(true);
    await shutdown(reopened);
  });

  it("checkDbFile n'écrit rien dans le fichier contrôlé", async () => {
    const keys = memoryKeyStore();
    const dir = tempDir();
    const app = await bootApp({ storage: { dataDir: dir, keyStores: [keys] } });
    const copy = join(tempDir(), "c.db");
    app.storage.db.snapshotTo(copy);
    const key = app.storage.findKey(dir);
    await shutdown(app);
    const before = readFileSync(copy);
    checkDbFile(copy, key);
    expect(readFileSync(copy).equals(before)).toBe(true);
  });

  it("profil non chiffré : adoptKey refuse (aucun magasin)", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false } });
    expect(app.storage.findKey(tempDir())).toBeNull();
    expect(() => app.storage.adoptKey(tempDir(), "k")).toThrow(/non chiffré/);
    await shutdown(app);
  });
});
