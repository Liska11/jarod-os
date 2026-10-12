/**
 * SPECS-P5-HYBRID.md §2.1 : table FTS5 des passages du RAG (`rag_chunks_fts`, contenu externe sur `rag_chunks`), tenue à jour par triggers,
 * reconstruite pour les passages déjà là, migration REJOUABLE, `rag_chunks` elle-même INCHANGÉE (pas d'ALTER). Bases réelles sur disque.
 */
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";
import { Db, MIGRATIONS } from "../src/db.js";
import { tempDir } from "./helpers.js";

const BLOB = Buffer.from(new Float32Array([1, 0, 0, 0]).buffer);
const insert = (db: Db, docId: string, ord: number, text: string) =>
  db.run("INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, 4, ?, 'h', ?, 'm', 1)", docId, ord, text, BLOB, docId);
const match = (db: Db, q: string) => db.all<{ doc_id: string; ord: number }>("SELECT c.doc_id, c.ord FROM rag_chunks_fts f JOIN rag_chunks c ON c.id = f.rowid WHERE rag_chunks_fts MATCH ? ORDER BY bm25(rag_chunks_fts)", q);

/** Base sur disque construite AVANT la migration FTS (toutes les migrations sauf la dernière), avec des passages déjà indexés. */
function baseBefore(): string {
  const path = join(tempDir(), "jarod.db");
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode = WAL");
  for (let v = 0; v < MIGRATIONS.length - 1; v++) raw.exec(MIGRATIONS[v]!);
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  const ins = raw.prepare("INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, 4, ?, 'h', ?, 'm', 1)");
  ins.run("a.pdf", 0, "L'authentification forte des agents de maintenance.", BLOB, "a.pdf");
  ins.run("a.pdf", 1, "Procédure de remplacement d'une carte réseau.", BLOB, "a.pdf");
  ins.run("b.xlsx", 0, "Matrice d'escalade conventionnelle niveau L2.", BLOB, "b.xlsx");
  raw.close();
  return path;
}

describe("rag_chunks_fts", () => {
  it("base neuve : un passage inséré est trouvé ; accents et casse ignorés, préfixe accepté", () => {
    const db = new Db(join(tempDir(), "jarod.db"));
    insert(db, "d1", 0, "L'éléphant traverse la rivière Authentification.");
    insert(db, "d2", 0, "Un autre texte sans rapport.");
    expect(match(db, '"ELEPHANT"')).toEqual([{ doc_id: "d1", ord: 0 }]);
    expect(match(db, '"authent"*')).toEqual([{ doc_id: "d1", ord: 0 }]);
    expect(match(db, '"introuvable"')).toEqual([]);
    db.close();
  });

  it("mise à jour du texte et suppression suivies par les triggers (ancien terme disparu, nouveau trouvé)", () => {
    const db = new Db(join(tempDir(), "jarod.db"));
    insert(db, "d1", 0, "ancienmot présent ici");
    insert(db, "d1", 1, "second passage");
    db.run("UPDATE rag_chunks SET text = 'nouveaumot présent ici' WHERE doc_id = 'd1' AND ord = 0");
    expect(match(db, '"ancienmot"')).toEqual([]);
    expect(match(db, '"nouveaumot"')).toEqual([{ doc_id: "d1", ord: 0 }]);
    db.run("DELETE FROM rag_chunks WHERE doc_id = 'd1'");
    expect(match(db, '"nouveaumot"')).toEqual([]);
    expect(match(db, '"second"')).toEqual([]);
    db.close();
  });

  it("migration d'une base qui a DÉJÀ des passages : l'index lexical est reconstruit, sauvegarde horodatée prise avant", () => {
    const path = baseBefore();
    const db = new Db(path);
    expect(db.get<{ user_version: number }>("PRAGMA user_version")?.user_version).toBe(MIGRATIONS.length);
    expect(match(db, '"authentification"')).toEqual([{ doc_id: "a.pdf", ord: 0 }]);
    expect(match(db, '"conventionnelle"')).toEqual([{ doc_id: "b.xlsx", ord: 0 }]);
    expect(db.all("SELECT count(*) AS n FROM rag_chunks")[0]).toEqual({ n: 3 });
    expect(db.migrationBackup).toBeTruthy();
    db.close();
  });

  it("rejouable : version ramenée en arrière puis rouverte = aucune erreur, aucun doublon dans l'index", () => {
    const path = baseBefore();
    new Db(path).close();
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    raw.close();
    const db = new Db(path, { backupBeforeMigrate: false });
    expect(match(db, '"authentification"')).toEqual([{ doc_id: "a.pdf", ord: 0 }]);
    expect(db.all("SELECT count(*) AS n FROM rag_chunks_fts WHERE rag_chunks_fts MATCH '\"escalade\"'")[0]).toEqual({ n: 1 });
    expect(db.all("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'rag_chunks_%' AND type = 'trigger'")[0]).toEqual({ n: 3 });
    db.close();
  });

  it("`rag_chunks` n'est pas modifiée : mêmes colonnes qu'avant la migration", () => {
    const path = baseBefore();
    const raw = new Database(path, { readonly: true });
    const before = (raw.prepare("SELECT name FROM pragma_table_info('rag_chunks')").all() as { name: string }[]).map((c) => c.name);
    raw.close();
    const db = new Db(path);
    expect(db.all<{ name: string }>("SELECT name FROM pragma_table_info('rag_chunks')").map((c) => c.name)).toEqual(before);
    db.close();
  });

  it("l'index passe le contrôle d'intégrité de FTS5", () => {
    const db = new Db(join(tempDir(), "jarod.db"));
    insert(db, "d1", 0, "premier texte à indexer");
    insert(db, "d1", 1, "second texte à indexer");
    db.run("UPDATE rag_chunks SET text = 'modifié' WHERE ord = 1");
    expect(() => db.run("INSERT INTO rag_chunks_fts(rag_chunks_fts, rank) VALUES ('integrity-check', 1)")).not.toThrow();
    db.close();
  });
});
