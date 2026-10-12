// Portage de packages/core/test/encryption.test.ts (rév. 2e180305).
// `JarodCore` → kernel + plugin-storage ; les services sessions/messages/memory (Phase 1-2) sont
// remplacés par les mêmes écritures SQL sur les mêmes tables (triggers FTS inclus).
// Non portés ici : :68-90 (backup/import → `importBackupInto`, core.ts:177, Phase 1),
// :103-127 (pièces jointes chiffrées → plugin-rag, Phase 2).
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootApp, shutdown } from "@jarod/kernel/testing";
import { describe, expect, it } from "vitest";
import { Db, ftsQuery, isEncryptedDb, isPlainDb } from "../src/db.js";
import { defaultKeyStores, fileKeyStore, type KeyStore, memoryKeyStore, resolveDbKey } from "../src/dbkey.js";
import { tempDir } from "./helpers.js";

const SECRET = "Mon code secret est 4242";

const open = (dataDir: string, extra: Record<string, unknown> = {}) => bootApp({ storage: { dataDir, ...extra } });

/** Writes a recognisable message and closes the kernel so everything is flushed to the main file. */
async function seed(app: Awaited<ReturnType<typeof open>>): Promise<string> {
  const db = app.storage.db;
  const id = "session-coffre";
  const t = Date.now();
  db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", id, "Coffre", t, t);
  db.run(
    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)",
    "m1",
    id,
    SECRET,
    t,
  );
  db.run(
    "INSERT INTO memories (id, type, content, created_at, updated_at) VALUES ('mem1', 'preference', ?, ?, ?)",
    "Préfère le thé",
    t,
    t,
  );
  await shutdown(app);
  return id;
}

const firstMessage = (db: Db, sessionId: string) =>
  db.get<{ content: string }>("SELECT content FROM messages WHERE session_id = ? ORDER BY seq LIMIT 1", sessionId)
    ?.content;
const searchSessions = (db: Db, text: string) =>
  db
    .all<{ session_id: string }>(
      "SELECT DISTINCT m.session_id FROM messages_fts f JOIN messages m ON m.seq = f.rowid WHERE messages_fts MATCH ?",
      ftsQuery(text)!,
    )
    .map((r) => r.session_id);
const searchMemories = (db: Db, text: string) =>
  db
    .all<{ content: string }>(
      "SELECT m.content FROM memories_fts f JOIN memories m ON m.seq = f.rowid WHERE memories_fts MATCH ?",
      ftsQuery(text)!,
    )
    .map((r) => r.content);

const fileContains = (dir: string, text: string) =>
  readdirSync(dir)
    .filter((f) => f.startsWith("jarod.db"))
    .some((f) => readFileSync(join(dir, f)).includes(Buffer.from(text, "utf8")));

describe("database encryption", () => {
  it("encrypts new databases: nothing readable on disk, data back with the key", async () => {
    const dir = tempDir();
    const keys = memoryKeyStore();
    const app = await open(dir, { keyStores: [keys] });
    expect(app.storage.dbEncryption).toEqual({ encrypted: true, keyStore: "Mémoire (tests)", weak: false });
    const id = await seed(app);

    expect(isEncryptedDb(join(dir, "jarod.db"))).toBe(true);
    expect(fileContains(dir, SECRET)).toBe(false);

    const again = await open(dir, { keyStores: [keys] });
    expect(firstMessage(again.storage.db, id)).toBe(SECRET);
    expect(searchSessions(again.storage.db, "secret")).toEqual([id]);
    await shutdown(again);
  });

  it("migrates an existing clear database in place, keeping full-text search", async () => {
    const dir = tempDir();
    const id = await seed(await open(dir, { encryptDb: false }));
    expect(isPlainDb(join(dir, "jarod.db"))).toBe(true);
    expect(fileContains(dir, SECRET)).toBe(true);

    const app = await open(dir, { keyStores: [memoryKeyStore()] });
    expect(firstMessage(app.storage.db, id)).toBe(SECRET);
    expect(searchMemories(app.storage.db, "the")).toEqual(["Préfère le thé"]);
    await shutdown(app);
    expect(isEncryptedDb(join(dir, "jarod.db"))).toBe(true);
    expect(fileContains(dir, SECRET)).toBe(false);
    expect(readdirSync(dir).some((f) => f.includes("avant-chiffrement"))).toBe(false);
  });

  it("folds the write-ahead log a crash left behind as soon as the database opens", async () => {
    const keys = memoryKeyStore();
    const live = tempDir();
    const app = await open(live, { keyStores: [keys] });
    const id = "session-apres-crash";
    const t = Date.now();
    app.storage.db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", id, "Crash", t, t);
    app.storage.db.run(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('mc', ?, 'user', ?, ?)",
      id,
      SECRET,
      t,
    );
    const key = resolveDbKey(live, [keys], true).key;
    // Trio copié pendant que la base est ouverte : l'image exacte d'un arrêt brutal.
    const crash = tempDir();
    for (const f of ["jarod.db", "jarod.db-wal", "jarod.db-shm"]) copyFileSync(join(live, f), join(crash, f));
    keys.save(crash, key);
    await shutdown(app);

    const recovered = await open(crash, { keyStores: [keys] });
    expect(firstMessage(recovered.storage.db, id)).toBe(SECRET);
    // Le fichier principal, copié AVANT la fermeture, doit déjà tout contenir.
    const alone = tempDir();
    copyFileSync(join(crash, "jarod.db"), join(alone, "jarod.db"));
    keys.save(alone, key);
    const reader = await open(alone, { keyStores: [keys] });
    expect(firstMessage(reader.storage.db, id)).toBe(SECRET);
    await shutdown(reader);
    await shutdown(recovered);
  });

  it("removes the clear copy an interrupted encryption left behind", async () => {
    const clear = tempDir();
    await seed(await open(clear, { encryptDb: false }));
    const clearCopy = readFileSync(join(clear, "jarod.db"));

    const keys = memoryKeyStore();
    const dir = tempDir();
    await seed(await open(dir, { keyStores: [keys] }));
    const orphan = join(dir, "jarod.db.avant-chiffrement");
    writeFileSync(orphan, clearCopy);
    expect(fileContains(dir, SECRET)).toBe(true); // la copie de secours expose le secret en clair

    const app = await open(dir, { keyStores: [keys] });
    expect(existsSync(orphan)).toBe(false);
    expect(fileContains(dir, SECRET)).toBe(false);
    await shutdown(app);
  });

  it("leaves no write-ahead log behind when it closes", async () => {
    const dir = tempDir();
    const app = await open(dir, { keyStores: [memoryKeyStore()] });
    await seed(app);
    expect(readdirSync(dir).filter((f) => f.startsWith("jarod.db-"))).toEqual([]);
  });

  it("closes without touching a journal another connection still holds", () => {
    // Deux connexions sur la même base : c'est le cas réel (application + `jarod` en ligne de commande).
    // Fermer la première ne doit rien supprimer — sous Windows l'effacement échoue (EPERM), et sous
    // POSIX il ferait perdre à la seconde les transactions encore dans le journal.
    const dir = tempDir();
    const path = join(dir, "jarod.db");
    const first = new Db(path);
    const t = Date.now();
    first.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s1', 'Coffre', ?, ?)", t, t);
    const second = new Db(path);
    expect(existsSync(`${path}-wal`)).toBe(true);

    expect(() => first.close()).not.toThrow();

    second.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES ('s2', 'Après', ?, ?)", t, t);
    expect(second.all<{ id: string }>("SELECT id FROM sessions ORDER BY id").map((r) => r.id)).toEqual(["s1", "s2"]);
    second.close();

    const reader = new Db(path);
    expect(reader.all<{ id: string }>("SELECT id FROM sessions ORDER BY id").map((r) => r.id)).toEqual(["s1", "s2"]);
    reader.close();
  });

  it("refuses to open (or replace) an encrypted database without its key", async () => {
    const dir = tempDir();
    await seed(await open(dir, { keyStores: [memoryKeyStore()] }));
    const before = readFileSync(join(dir, "jarod.db"));
    await expect(open(dir, { keyStores: [memoryKeyStore()] })).rejects.toThrow(/clé est introuvable/);

    const wrong: KeyStore = { ...memoryKeyStore(), load: () => "0".repeat(64) };
    await expect(open(dir, { keyStores: [wrong] })).rejects.toThrow(/incorrect/);
    expect(readFileSync(join(dir, "jarod.db")).equals(before)).toBe(true);
  });

  it("backs up a clear copy only with a password (Db.backupTo)", async () => {
    const dir = tempDir();
    const app = await open(dir, { keyStores: [memoryKeyStore()] });
    const file = join(tempDir(), "sauvegarde.db");
    expect(() => app.storage.db.backupTo(file)).toThrow(/mot de passe/);
    app.storage.db.backupTo(file, "correct horse battery");
    await shutdown(app);
    expect(isEncryptedDb(file)).toBe(true);
  });

  it("falls back to a private key file when the OS keychain is unusable", () => {
    const dir = tempDir();
    const broken: KeyStore = {
      id: "dpapi",
      label: "cassé",
      load: () => null,
      save: () => {
        throw new Error("indisponible");
      },
    };
    const { key, store } = resolveDbKey(dir, [broken, fileKeyStore], false);
    expect(store.id).toBe("file");
    expect(readFileSync(join(dir, "db.key"), "utf8")).toBe(key);
    expect(resolveDbKey(dir, [broken, fileKeyStore], true).key).toBe(key);
  });

  it.runIf(process.platform === "win32")("protects the key with Windows DPAPI", { timeout: 30_000 }, () => {
    const dir = tempDir();
    const { key, store } = resolveDbKey(dir, defaultKeyStores(), false);
    expect(store.id).toBe("dpapi");
    expect(existsSync(join(dir, "db.key"))).toBe(false);
    const blob = readFileSync(join(dir, "db.key.dpapi"), "utf8");
    expect(blob).not.toContain(key);
    expect(resolveDbKey(dir, defaultKeyStores(), true).key).toBe(key);
    // A tampered blob is rejected rather than yielding a wrong key.
    writeFileSync(join(dir, "db.key.dpapi"), Buffer.from("x".repeat(64)).toString("base64"));
    expect(() => resolveDbKey(dir, defaultKeyStores(), true)).toThrow(/introuvable/);
  });
});
