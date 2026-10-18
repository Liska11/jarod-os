// Sauvegarde externe : la copie de la base garde les conversations et la clé, mais plus aucune valeur de la table `secrets`.
// Valeurs factices uniquement.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db, isEncryptedDb, isPlainDb, snapshotWithoutSecrets } from "../src/db.js";
import { tempDir } from "./helpers.js";

const FAKE = "valeur-factice-coffre-0003";
const KEY = "cle-de-test-0123456789abcdef";

function seeded(path: string, key: string | null): void {
  const db = new Db(path, key ? { key } : {});
  const t = Date.now();
  db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Gardée', ?, ?)", t, t);
  db.run("INSERT INTO secrets (key, value) VALUES ('vault:github_token', ?)", FAKE);
  db.run("INSERT INTO settings (key, value) VALUES ('vault', ?)", JSON.stringify([{ name: "github_token", domains: ["api.github.com"] }]));
  // Une écriture laissée dans le journal (WAL) doit être dans la copie aussi.
  db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s2', 'Dans le journal', ?, ?)", t, t);
  db.close();
}

describe("snapshotWithoutSecrets", () => {
  it("base chiffrée : copie chiffrée avec la même clé, conversations et noms gardés, valeurs retirées, source intacte", () => {
    const dir = tempDir();
    const src = join(dir, "jarod.db");
    const dest = join(dir, "copie.db");
    seeded(src, KEY);
    const before = readFileSync(src);

    expect(snapshotWithoutSecrets(src, dest, KEY)).toEqual({ removed: 1 });

    expect(isEncryptedDb(dest)).toBe(true);
    expect(readFileSync(dest).includes(Buffer.from(FAKE))).toBe(false);
    const copy = new Db(dest, { key: KEY });
    expect(copy.all<{ id: string }>("SELECT id FROM sessions ORDER BY id").map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(copy.all("SELECT * FROM secrets")).toEqual([]);
    expect(copy.get<{ value: string }>("SELECT value FROM settings WHERE key = 'vault'")?.value).toContain("github_token");
    copy.close();
    expect(() => new Db(dest, { key: "mauvaise-cle" })).toThrow();
    expect(readFileSync(src).equals(before)).toBe(true);
  });

  it("base en clair : copie en clair, sans la valeur, même dans les pages libérées", () => {
    const dir = tempDir();
    const src = join(dir, "jarod.db");
    const dest = join(dir, "copie.db");
    seeded(src, null);

    expect(snapshotWithoutSecrets(src, dest, null).removed).toBe(1);
    expect(isPlainDb(dest)).toBe(true);
    expect(readFileSync(dest).includes(Buffer.from(FAKE))).toBe(false);
  });

  it("refuse d'écraser une destination existante", () => {
    const dir = tempDir();
    const src = join(dir, "jarod.db");
    seeded(src, null);
    expect(() => snapshotWithoutSecrets(src, src, null)).toThrow(/déjà présente/);
  });
});
