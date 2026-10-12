/**
 * SPECS-P5-CLI.md §3 (`jarod health`) : `inspectDbFile` ouvre un fichier de base EN LECTURE SEULE, vérifie `quick_check`, rend la version du schéma
 * et le réglage `ecosystem` — sans migrer, sans écrire un octet de la base.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { Db, inspectDbFile, MIGRATIONS } from "../src/db.js";
import { DbKeyError } from "../src/dbkey.js";
import { tempDir } from "./helpers.js";

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const KEY = "a".repeat(64);

function makeDb(key: string | null): string {
  const path = join(tempDir(), "jarod.db");
  const db = new Db(path, { key });
  db.run("INSERT INTO settings (key, value) VALUES ('ecosystem', ?)", JSON.stringify({ reranker: "bge-reranker-v2-m3-npu", rerankMode: "shadow" }));
  db.close();
  return path;
}

describe("inspectDbFile", () => {
  it("rend la version du schéma et le réglage ecosystem d'une base chiffrée, sans rien écrire", () => {
    const path = makeDb(KEY);
    const before = sha(path);
    const r = inspectDbFile(path, KEY);
    expect(r.userVersion).toBe(MIGRATIONS.length);
    expect(r.ecosystem).toEqual({ reranker: "bge-reranker-v2-m3-npu", rerankMode: "shadow" });
    expect(sha(path)).toBe(before);
  });

  it("lit aussi une base en clair, et rend ecosystem = null quand le réglage n'existe pas", () => {
    const path = join(tempDir(), "jarod.db");
    new Db(path, { key: null }).close();
    const r = inspectDbFile(path, null);
    expect(r.userVersion).toBe(MIGRATIONS.length);
    expect(r.ecosystem).toBeNull();
  });

  it("ne MIGRE jamais : une base restée à la version précédente garde sa version et son contenu", () => {
    const path = join(tempDir(), "jarod.db");
    const raw = new Database(path);
    raw.exec("PRAGMA journal_mode = WAL");
    for (let v = 0; v < MIGRATIONS.length - 1; v++) raw.exec(MIGRATIONS[v]!);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    raw.close();
    const before = sha(path);
    const r = inspectDbFile(path, null);
    expect(r.userVersion).toBe(MIGRATIONS.length - 1);
    expect(sha(path)).toBe(before);
    const check = new Database(path, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length - 1);
    check.close();
  });

  it("ne rend que les réglages DEMANDÉS (liste blanche), jamais les autres", () => {
    const path = makeDb(KEY);
    const db = new Db(path, { key: KEY });
    db.run("INSERT INTO settings (key, value) VALUES ('persona', ?)", JSON.stringify("PHRASE-SECRETE"));
    db.run("INSERT INTO settings (key, value) VALUES ('agentMode', ?)", JSON.stringify("plan"));
    db.close();
    const r = inspectDbFile(path, KEY, undefined, ["agentMode", "absent"]);
    expect(r.settings).toEqual({ agentMode: "plan" });
    expect(JSON.stringify(r)).not.toContain("PHRASE-SECRETE");
    expect(inspectDbFile(path, KEY).settings).toEqual({});
  });

  it("clé fausse → DbKeyError ; fichier abîmé → erreur", () => {
    const path = makeDb(KEY);
    expect(() => inspectDbFile(path, "b".repeat(64))).toThrow(DbKeyError);
    const bytes = readFileSync(path);
    for (let i = 4096; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    writeFileSync(path, bytes);
    expect(() => inspectDbFile(path, KEY)).toThrow();
  });
});
