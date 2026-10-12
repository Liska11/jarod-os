/**
 * Jarod-cordis (Q10) : migration additive `sessions.model_pinned` (v15) précédée d'une sauvegarde horodatée
 * de la base existante, vérifiée (même clé, intègre, version de départ) — sinon pas de migration.
 * Bases réelles sur disque (claire et chiffrée), construites au niveau v14 avec les migrations d'origine.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { Db, MIGRATIONS } from "../src/db.js";
import { tempDir } from "./helpers.js";

/** Niveau de la source Jarod-one (avant Q10). */
const V14 = 14;
const KEY = "clé-de-test-q10";

/** Base au niveau v14 (avant Q10), avec une conversation dont le contexte est rempli. */
function baseAt(level: number, key: string | null): string {
  const path = join(tempDir(), "jarod.db");
  const raw = new Database(path);
  raw.pragma("cipher = 'chacha20'");
  if (key) raw.pragma(`key = '${key}'`);
  raw.exec("PRAGMA journal_mode = WAL");
  for (let v = 0; v < level; v++) raw.exec(MIGRATIONS[v]!);
  raw.exec(`PRAGMA user_version = ${level}`);
  raw
    .prepare("INSERT INTO sessions (id, title, created_at, updated_at, workspace, provider, model, agent_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("s1", "Ancienne", 1, 2, "C:/w", "openai", "gpt-x", "build");
  raw.close();
  return path;
}
const baseV14 = (key: string | null) => baseAt(V14, key);

const backups = (path: string) => {
  const dir = join(path, "..", "backups");
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("Q10 — migration model_pinned précédée d'une sauvegarde", () => {
  it("v14 → dernière version (base chiffrée) : sauvegarde horodatée à la version de départ, même clé ; colonne ajoutée à 0, données intactes", () => {
    const path = baseV14(KEY);
    const db = new Db(path, { key: KEY });
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.get("SELECT id, provider, model, model_pinned FROM sessions")).toEqual({ id: "s1", provider: "openai", model: "gpt-x", model_pinned: 0 });
    expect(db.migrationBackup).toMatch(new RegExp(`jarod\\.db\\.v${V14}-avant-v${MIGRATIONS.length}\\.\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.bak$`));
    db.close();

    const b = new Database(db.migrationBackup!, { readonly: true });
    b.pragma("cipher = 'chacha20'");
    b.pragma(`key = '${KEY}'`);
    expect(b.pragma("user_version", { simple: true })).toBe(V14);
    expect(b.pragma("quick_check", { simple: true })).toBe("ok");
    expect(b.prepare("SELECT id, title, provider, model FROM sessions").all()).toEqual([{ id: "s1", title: "Ancienne", provider: "openai", model: "gpt-x" }]);
    expect(b.prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'model_pinned'").all()).toEqual([]);
    b.close();
    // Sans la clé, la sauvegarde est illisible (jamais de copie en clair d'une base chiffrée).
    const clear = new Database(db.migrationBackup!, { readonly: true });
    expect(() => clear.prepare("SELECT count(*) FROM sqlite_master").get()).toThrow();
    clear.close();
  });

  it("base déjà à jour, ou base neuve : aucune sauvegarde", () => {
    const fresh = join(tempDir(), "jarod.db");
    const a = new Db(fresh);
    expect(a.migrationBackup).toBeNull();
    a.close();
    const b = new Db(fresh);
    expect(b.migrationBackup).toBeNull();
    b.close();
    expect(backups(fresh)).toEqual([]);
  });

  it("sauvegarde impossible : migration ANNULÉE, base laissée en v14", () => {
    const path = baseV14(null);
    writeFileSync(join(path, "..", "backups"), "un fichier à la place du dossier");
    expect(() => new Db(path)).toThrow(new RegExp(`Migration v14 → v${MIGRATIONS.length} annulée : sauvegarde préalable impossible`));
    const raw = new Database(path, { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(V14);
    raw.close();
  });

  it("migration rejouée (user_version ramenée à v14 sur une base qui a la colonne) : sans effet, pas d'erreur", () => {
    const path = baseV14(null);
    new Db(path).close();
    const raw = new Database(path);
    raw.prepare("UPDATE sessions SET model_pinned = 1").run();
    raw.exec(`PRAGMA user_version = ${V14}`);
    raw.close();
    const db = new Db(path);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.get("SELECT model_pinned FROM sessions")).toEqual({ model_pinned: 1 });
    db.close();
  });

  it("backupBeforeMigrate: false : migre sans sauvegarde (option explicite)", () => {
    const path = baseV14(null);
    const db = new Db(path, { backupBeforeMigrate: false });
    expect(db.migrationBackup).toBeNull();
    expect(backups(path)).toEqual([]);
    db.close();
  });
});

describe("Q13-1 — migration v16 (continuité de session) précédée d'une sauvegarde", () => {
  const V15 = 15;
  const tables = (db: Db) => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_continuations', 'session_local_errors') ORDER BY name").map((r) => r.name);

  it("v15 → dernière (base chiffrée) : sauvegarde « v15-avant-vN » vérifiée, deux tables vides ajoutées, données intactes", () => {
    const path = baseAt(V15, KEY);
    const db = new Db(path, { key: KEY });
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(16);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.migrationBackup).toMatch(new RegExp(`jarod\\.db\\.v15-avant-v${MIGRATIONS.length}\\.\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.bak$`));
    expect(tables(db)).toEqual(["session_continuations", "session_local_errors"]);
    expect(db.get("SELECT COUNT(*) AS n FROM session_continuations")).toEqual({ n: 0 });
    expect(db.get("SELECT id, title, provider, model, model_pinned FROM sessions")).toEqual({ id: "s1", title: "Ancienne", provider: "openai", model: "gpt-x", model_pinned: 0 });
    db.close();
    const b = new Database(db.migrationBackup!, { readonly: true });
    b.pragma("cipher = 'chacha20'");
    b.pragma(`key = '${KEY}'`);
    expect(b.pragma("user_version", { simple: true })).toBe(V15);
    expect(b.pragma("quick_check", { simple: true })).toBe("ok");
    expect(b.prepare("SELECT name FROM sqlite_master WHERE name IN ('session_continuations', 'session_local_errors')").all()).toEqual([]);
    b.close();
  });

  it("suppression d'une conversation : ses continuations et erreurs locales partent avec elle (cascade)", () => {
    const db = new Db(join(tempDir(), "jarod.db"));
    db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('a', 'A', 1, 1), ('b', 'B', 1, 1)");
    db.run("INSERT INTO session_continuations (session_id, items, created_at, updated_at) VALUES ('a', '[]', 1, 1), ('b', '[]', 1, 1)");
    db.run("INSERT INTO session_local_errors (session_id, user_content, error_text, created_at) VALUES ('a', 'q', 'e', 1)");
    db.run("DELETE FROM sessions WHERE id = 'a'");
    expect(db.all("SELECT session_id FROM session_continuations")).toEqual([{ session_id: "b" }]);
    expect(db.get("SELECT COUNT(*) AS n FROM session_local_errors")).toEqual({ n: 0 });
    db.close();
  });

  it("migration rejouée (user_version ramenée à v15, tables remplies) : sans effet, lignes gardées", () => {
    const path = baseAt(V15, null);
    const first = new Db(path, { backupBeforeMigrate: false });
    first.run("INSERT INTO session_continuations (session_id, items, created_at, updated_at) VALUES ('s1', '[1]', 1, 1)");
    first.close();
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${V15}`);
    raw.close();
    const db = new Db(path, { backupBeforeMigrate: false });
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.get("SELECT items FROM session_continuations")).toEqual({ items: "[1]" });
    db.close();
  });
});

describe("Q17 — migration v17 (plugin-kanban) précédée d'une sauvegarde", () => {
  const V16 = 16;
  const KANBAN = ["kanban_boards", "kanban_comments", "kanban_events", "kanban_runs", "kanban_task_links", "kanban_tasks"];
  const kanbanTables = (all: (sql: string) => { name: string }[]) =>
    all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kanban_%' ORDER BY name").map((r) => r.name);

  it("v16 → dernière version (base chiffrée) : sauvegarde « v16-avant-vN » vérifiée (sans tables kanban), six tables vides ajoutées, données intactes", () => {
    const path = baseAt(V16, KEY);
    const db = new Db(path, { key: KEY });
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(17);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.migrationBackup).toMatch(new RegExp(`jarod\\.db\\.v16-avant-v${MIGRATIONS.length}\\.\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.bak$`));
    expect(kanbanTables((sql) => db.all(sql))).toEqual(KANBAN);
    for (const t of KANBAN) expect(db.get(`SELECT COUNT(*) AS n FROM ${t}`), t).toEqual({ n: 0 });
    expect(db.get("SELECT id, title, model_pinned FROM sessions")).toEqual({ id: "s1", title: "Ancienne", model_pinned: 0 });
    db.close();
    const b = new Database(db.migrationBackup!, { readonly: true });
    b.pragma("cipher = 'chacha20'");
    b.pragma(`key = '${KEY}'`);
    expect(b.pragma("user_version", { simple: true })).toBe(V16);
    expect(b.pragma("quick_check", { simple: true })).toBe("ok");
    expect(kanbanTables((sql) => b.prepare(sql).all() as { name: string }[])).toEqual([]);
    b.close();
  });

  it("suppressions en cascade : tableau → tâches → liens, commentaires, événements, exécutions ; conversation supprimée = lien vidé", () => {
    const db = new Db(join(tempDir(), "jarod.db"));
    db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s', 'S', 1, 1)");
    db.run("INSERT INTO kanban_boards (slug, name, created_at) VALUES ('b', 'B', 1)");
    db.run("INSERT INTO kanban_tasks (id, board, title, status, created_at, session_id) VALUES ('p', 'b', 'P', 'done', 1, 's'), ('c', 'b', 'C', 'ready', 1, NULL)");
    db.run("INSERT INTO kanban_task_links (parent_id, child_id) VALUES ('p', 'c')");
    db.run("INSERT INTO kanban_comments (task_id, body, created_at) VALUES ('p', 'x', 1)");
    db.run("INSERT INTO kanban_events (task_id, kind, created_at) VALUES ('p', 'created', 1)");
    db.run("INSERT INTO kanban_runs (task_id, status, started_at) VALUES ('p', 'done', 1)");
    db.run("DELETE FROM sessions WHERE id = 's'");
    expect(db.get("SELECT session_id FROM kanban_tasks WHERE id = 'p'")).toEqual({ session_id: null });
    db.run("DELETE FROM kanban_tasks WHERE id = 'p'");
    expect(db.get("SELECT COUNT(*) AS n FROM kanban_task_links")).toEqual({ n: 0 });
    expect(db.get("SELECT (SELECT COUNT(*) FROM kanban_comments) + (SELECT COUNT(*) FROM kanban_events) + (SELECT COUNT(*) FROM kanban_runs) AS n")).toEqual({ n: 0 });
    db.run("DELETE FROM kanban_boards WHERE slug = 'b'");
    expect(db.get("SELECT COUNT(*) AS n FROM kanban_tasks")).toEqual({ n: 0 });
    expect(() => db.run("INSERT INTO kanban_boards (slug, name, is_current, created_at) VALUES ('x', 'X', 1, 1), ('y', 'Y', 1, 1)")).toThrow(/UNIQUE/);
    db.close();
  });

  it("migration rejouée (user_version ramenée à v16, tables remplies) : sans effet, lignes gardées", () => {
    const path = baseAt(V16, null);
    const first = new Db(path, { backupBeforeMigrate: false });
    first.run("INSERT INTO kanban_boards (slug, name, created_at) VALUES ('b', 'B', 1)");
    first.close();
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${V16}`);
    raw.close();
    const db = new Db(path, { backupBeforeMigrate: false });
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.get("SELECT slug FROM kanban_boards")).toEqual({ slug: "b" });
    db.close();
  });
});

describe("Q18 — migration v18 (état de travail par conversation) précédée d'une sauvegarde", () => {
  const V17 = 17;
  const hasTable = (get: (sql: string) => unknown) =>
    !!get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_state'");

  it("v17 → v18 (base chiffrée) : sauvegarde « v17-avant-v18 » vérifiée (sans la table), table vide ajoutée, données intactes", () => {
    const path = baseAt(V17, KEY);
    const db = new Db(path, { key: KEY });
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(18);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.migrationBackup).toMatch(new RegExp(`jarod\\.db\\.v17-avant-v${MIGRATIONS.length}\\.\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.bak$`));
    expect(hasTable((sql) => db.get(sql))).toBe(true);
    expect(db.get("SELECT COUNT(*) AS n FROM session_state")).toEqual({ n: 0 });
    expect(db.get("SELECT id, title, model_pinned FROM sessions")).toEqual({ id: "s1", title: "Ancienne", model_pinned: 0 });
    db.close();
    const b = new Database(db.migrationBackup!, { readonly: true });
    b.pragma("cipher = 'chacha20'");
    b.pragma(`key = '${KEY}'`);
    expect(b.pragma("user_version", { simple: true })).toBe(V17);
    expect(b.pragma("quick_check", { simple: true })).toBe("ok");
    expect(hasTable((sql) => b.prepare(sql).get())).toBe(false);
    b.close();
  });

  it("clé unique par conversation ; supprimée avec la conversation ; migration rejouée sans effet", () => {
    const path = baseAt(V17, null);
    const db = new Db(path, { backupBeforeMigrate: false });
    db.run("INSERT INTO session_state (session_id, key, type, value, updated_at) VALUES ('s1', 'k', 'text', '\"v\"', 1)");
    expect(() => db.run("INSERT INTO session_state (session_id, key, type, value, updated_at) VALUES ('s1', 'k', 'text', '\"w\"', 2)")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.run("INSERT INTO session_state (session_id, key, type, value, updated_at) VALUES ('inconnue', 'k', 'text', '1', 1)")).toThrow(/FOREIGN/);
    db.close();
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${V17}`);
    raw.close();
    const again = new Db(path, { backupBeforeMigrate: false });
    expect(again.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(again.get("SELECT value FROM session_state WHERE session_id = 's1'")).toEqual({ value: '"v"' });
    again.run("DELETE FROM sessions WHERE id = 's1'");
    expect(again.get("SELECT COUNT(*) AS n FROM session_state")).toEqual({ n: 0 });
    again.close();
  });
});

describe("Ingestion, lot A — migration v19 (documents et repérage des chunks) précédée d'une sauvegarde", () => {
  const V18 = 18;
  const NEW_TABLES = ["rag_documents", "rag_chunk_spans"];
  const hasTable = (get: (sql: string) => unknown, name: string) =>
    !!get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${name}'`);
  const CHUNK = "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES ('d', 0, 'texte', 1, x'0000803f', 'h', 's.md', 'm', 7)";

  it("v18 → v19 (base chiffrée) : sauvegarde « v18-avant-v19 » vérifiée (sans les tables), deux tables vides ajoutées, rag_chunks IDENTIQUE (colonnes et lignes)", () => {
    const path = baseAt(V18, KEY);
    const raw = new Database(path);
    raw.pragma("cipher = 'chacha20'");
    raw.pragma(`key = '${KEY}'`);
    raw.exec(CHUNK);
    const columnsBefore = raw.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info('rag_chunks')").all();
    const rowsBefore = raw.prepare("SELECT * FROM rag_chunks").all();
    raw.close();

    const db = new Db(path, { key: KEY });
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(19);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(db.migrationBackup).toMatch(new RegExp(`jarod\\.db\\.v18-avant-v${MIGRATIONS.length}\\.\\d{4}-\\d\\d-\\d\\dT[\\d-]+Z\\.bak$`));
    for (const t of NEW_TABLES) {
      expect(hasTable((sql) => db.get(sql), t), t).toBe(true);
      expect(db.get(`SELECT COUNT(*) AS n FROM ${t}`), t).toEqual({ n: 0 });
    }
    expect(db.all("SELECT name, type, \"notnull\", pk FROM pragma_table_info('rag_chunks')")).toEqual(columnsBefore);
    expect(db.all("SELECT * FROM rag_chunks")).toEqual(rowsBefore);
    expect(db.get("SELECT id, title FROM sessions")).toEqual({ id: "s1", title: "Ancienne" });
    db.close();

    const b = new Database(db.migrationBackup!, { readonly: true });
    b.pragma("cipher = 'chacha20'");
    b.pragma(`key = '${KEY}'`);
    expect(b.pragma("user_version", { simple: true })).toBe(V18);
    expect(b.pragma("quick_check", { simple: true })).toBe("ok");
    for (const t of NEW_TABLES) expect(hasTable((sql) => b.prepare(sql).get(), t), t).toBe(false);
    expect(b.prepare("SELECT * FROM rag_chunks").all()).toEqual(rowsBefore);
    b.close();
  });

  it("un document est unique par doc_id ; un repérage est unique par chunk, lié à lui et supprimé avec lui ; migration rejouée sans effet", () => {
    const path = baseAt(V18, null);
    const db = new Db(path, { backupBeforeMigrate: false });
    db.run(CHUNK);
    const id = db.get<{ id: number }>("SELECT id FROM rag_chunks")!.id;
    const span = "INSERT INTO rag_chunk_spans (chunk_id, char_start, char_end, page, section) VALUES (?, 0, 5, NULL, 'Titre')";
    db.run(span, id);
    expect(() => db.run(span, id)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => db.run(span, 99999)).toThrow(/FOREIGN/);
    const doc = "INSERT INTO rag_documents (doc_id, source, parser, parser_version, source_sha256, content_sha256, manifest, text, at) VALUES ('d', 's.md', 'builtin', '1', 'a', 'b', '{}', 'texte', 7)";
    db.run(doc);
    expect(() => db.run(doc)).toThrow(/UNIQUE|PRIMARY/);
    expect(db.get("SELECT state FROM rag_documents")).toEqual({ state: "indexed" });
    db.close();

    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${V18}`);
    raw.close();
    const again = new Db(path, { backupBeforeMigrate: false });
    expect(again.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(again.get("SELECT COUNT(*) AS n FROM rag_documents")).toEqual({ n: 1 });
    expect(again.get("SELECT chunk_id, section FROM rag_chunk_spans")).toEqual({ chunk_id: id, section: "Titre" });
    again.run("DELETE FROM rag_chunks WHERE doc_id = 'd'");
    expect(again.get("SELECT COUNT(*) AS n FROM rag_chunk_spans")).toEqual({ n: 0 });
    again.close();
  });
});

describe("Q13-2 — Db.snapshotTo (sauvegarde complète du profil)", () => {
  it("copie chiffrée avec la MÊME clé, vérifiée ; illisible sans clé ; destination existante refusée", () => {
    const dir = tempDir();
    const db = new Db(join(dir, "jarod.db"), { key: KEY });
    db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s', 'S', 1, 1)");
    const copy = join(dir, "copie.db");
    expect(db.snapshotTo(copy)).toEqual({ userVersion: MIGRATIONS.length });
    expect(() => db.snapshotTo(copy)).toThrow(/destination déjà présente/);
    db.close();
    const b = new Database(copy, { readonly: true });
    b.pragma("cipher = 'chacha20'");
    b.pragma(`key = '${KEY}'`);
    expect(b.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "s" }]);
    b.close();
    const clear = new Database(copy, { readonly: true });
    expect(() => clear.prepare("SELECT count(*) FROM sqlite_master").get()).toThrow();
    clear.close();
  });
});
