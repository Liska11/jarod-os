/// <reference path="./sqlite-driver.d.ts" />
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { DbKeyError } from "./dbkey.js";

export type SqlValue = string | number | bigint | Buffer | Uint8Array | null;

/** Schema migrations, applied in order and tracked with PRAGMA user_version. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    thinking TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    tool_name TEXT,
    is_error INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    raw TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_session ON messages(session_id, seq);

  CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.seq, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
  END;

  CREATE TABLE memories (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='seq', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
  END;

  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL,
    log TEXT NOT NULL,
    vars TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN attachments TEXT;
  ALTER TABLE messages ADD COLUMN kind TEXT;
  ALTER TABLE messages ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    file TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    spec TEXT NOT NULL,
    session_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run INTEGER,
    next_run INTEGER,
    last_status TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE gateway_chats (
    gateway TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    PRIMARY KEY (gateway, chat_id)
  );
  `,
  `
  -- Per-conversation context, pinned at the first run (NULL provider = not pinned yet).
  ALTER TABLE sessions ADD COLUMN workspace TEXT;
  ALTER TABLE sessions ADD COLUMN provider TEXT;
  ALTER TABLE sessions ADD COLUMN model TEXT;
  ALTER TABLE sessions ADD COLUMN agent_mode TEXT;

  ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER;
  ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER;

  -- Content of files before the agent changed them, per turn (for /rewind).
  CREATE TABLE file_checkpoints (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn INTEGER NOT NULL,
    path TEXT NOT NULL,
    content BLOB,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, turn, path)
  );
  `,
  `
  -- Append-only event log (EventStore). Shadow log: the relational tables stay the source of truth,
  -- this only records what happened so a turn can be replayed, audited or streamed to another
  -- process. A failure here must never break a conversation, see EventStoreService.append.
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX events_stream ON events(stream, seq);
  CREATE INDEX events_type ON events(type, seq);
  `,
  /**
   * Local retrieval index. It lives in this database on purpose: the file is already encrypted at
   * rest and already covered by the backups, so a second index file would only be one more thing to
   * lose. One row per (document, position): the invariant worth constraining is that a document has
   * one chunk at a given place — not that a content hash is unique, since every chunk of a document
   * shares that hash. Deduplication is the lookup on (doc_id, sha256), so it gets a plain index.
   */
  `
  CREATE TABLE rag_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    dim INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    source TEXT,
    model TEXT,
    at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX rag_chunks_doc ON rag_chunks(doc_id, ord);
  CREATE INDEX rag_chunks_hash ON rag_chunks(doc_id, sha256);
  CREATE INDEX rag_chunks_source ON rag_chunks(source);
  `,
  /**
   * Repairs an index built on (doc_id, sha256): every chunk of one document carries the same hash, so
   * that uniqueness silently allowed a single chunk per document — a long file could not be indexed.
   * The hash index is a lookup for the "already indexed" check, never a constraint.
   */
  `
  DROP INDEX IF EXISTS rag_chunks_doc;
  CREATE UNIQUE INDEX IF NOT EXISTS rag_chunks_doc ON rag_chunks(doc_id, ord);
  CREATE INDEX IF NOT EXISTS rag_chunks_hash ON rag_chunks(doc_id, sha256);
  `,
  `
  -- IF NOT EXISTS on both: a migration can be re-applied to a base that already carries its
  -- objects (that is exactly what the rag repair migration below exists for), and it must not throw.
  CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    ref TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    side TEXT NOT NULL,
    text TEXT NOT NULL,
    anchor TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS annotations_ref ON annotations(ref, file, line);
  `,
  `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    last_error TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, due_at);
  `,
  /**
   * What the curator knows about each skill: how often it was loaded and patched, when it was last
   * used, and whether the user pinned it. The skill files stay the source of truth for content.
   */
  `
  CREATE TABLE IF NOT EXISTS skill_usage (
    id TEXT PRIMARY KEY,
    uses INTEGER NOT NULL DEFAULT 0,
    patches INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_used_at INTEGER,
    state TEXT NOT NULL DEFAULT 'active',
    pinned INTEGER NOT NULL DEFAULT 0
  );
  `,
  /**
   * A scheduled task may also send its answer to a messaging chat. Its own table rather than a new
   * column: a migration must survive being applied twice, and SQLite has no ADD COLUMN IF NOT EXISTS.
   */
  `
  CREATE TABLE IF NOT EXISTS schedule_deliveries (
    schedule_id TEXT PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
    gateway TEXT NOT NULL,
    chat_id TEXT NOT NULL
  );
  `,
  /** Standing goals (`/goal`) and the agent's working list (`todo`), per conversation. */
  `
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    objective TEXT NOT NULL,
    criteria TEXT NOT NULL,
    status TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 1,
    max_iterations INTEGER NOT NULL,
    last_results TEXT,
    note TEXT,
    errors INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS goals_session ON goals(session_id, created_at);
  CREATE TABLE IF NOT EXISTS session_todos (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    items TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /** Pending pairing requests of the messaging gateways (one-time codes, see `services/pairing.ts`). */
  `
  CREATE TABLE IF NOT EXISTS gateway_pairings (
    code TEXT PRIMARY KEY,
    gateway TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    name TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  /** Descriptions of images written for the models that cannot see them (`services/vision.ts`). */
  `
  CREATE TABLE IF NOT EXISTS image_descriptions (
    attachment_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  /** Rapports de l'auto-amélioration (`services/auto-improvement.ts`) : les 20 derniers sont gardés. */
  `
  CREATE TABLE IF NOT EXISTS auto_improvement_reports (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    report TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auto_improvement_reports_created ON auto_improvement_reports (created_at);
  `,
  /**
   * Jarod-cordis (Q10, décision utilisateur 2026-09-27) : une conversation ÉPINGLÉE garde son modèle (choix
   * « pour cette conversation seulement » de l'écran Chat, `set-session-model-override`) ; 0 = elle suit le
   * modèle actif. Sans ce drapeau, « choisi pour cette conversation » et « a suivi le modèle actif » sont
   * indiscernables (`provider`/`model` sont toujours remplis). Additive : une base de ce niveau reste lisible
   * par la source (v14), dont les INSERT sans la colonne donnent 0 = « suit le modèle actif ».
   */
  `
  ALTER TABLE sessions ADD COLUMN model_pinned INTEGER NOT NULL DEFAULT 0;
  `,
  /**
   * Jarod-cordis (Q13-1, décision utilisateur 2026-09-28 : « continuité ») : ce que l'écran Chat ré-affiche à la
   * réouverture d'une conversation — le début d'une conversation POURSUIVIE (éléments de l'ancienne, recopiés
   * dans la nouvelle) et l'erreur LOCALE d'un envoi échoué, que le kernel n'a jamais reçue. Tables de SANK-UI
   * (`session-continuation-store.ts:27-42`, dans `state.db`), rattachées ici à `sessions` (suppression en
   * cascade) ; horodatages en millisecondes (convention Jarod). Additive et rejouable (`IF NOT EXISTS`) : une
   * base v16 reste lisible par la source (v14), qui ignore ces tables.
   */
  `
  CREATE TABLE IF NOT EXISTS session_continuations (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    items TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_local_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_content TEXT NOT NULL,
    error_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_local_errors_session ON session_local_errors (session_id);
  `,
  /**
   * Jarod-cordis (Q17, décision utilisateur 2026-09-28 : option A) : plugin-kanban — tableaux, tâches, liens
   * parent/enfant, commentaires, événements, exécutions. Colonnes calquées sur le `kanban.db` d'Hermes
   * (`hermes_cli/kanban_db.py`, SCHEMA_SQL), réduites à ce que Jarod sert ; horodatages en millisecondes
   * (convention Jarod). Une carte est AUTONOME (pas de référence à `goals`) ; `session_id` = conversation
   * du dernier tour d'agent qui l'a exécutée. Additive et rejouable (`IF NOT EXISTS`), tables vides : une base
   * v17 reste lisible par la source (v14), qui ignore ces tables.
   */
  `
  CREATE TABLE IF NOT EXISTS kanban_boards (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    color TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    is_current INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS kanban_boards_current ON kanban_boards (is_current) WHERE is_current = 1;
  CREATE TABLE IF NOT EXISTS kanban_tasks (
    id TEXT PRIMARY KEY,
    board TEXT NOT NULL REFERENCES kanban_boards(slug) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    assignee TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    tenant TEXT,
    workspace_kind TEXT NOT NULL DEFAULT 'scratch',
    workspace_path TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    result TEXT,
    skills TEXT,
    max_retries INTEGER,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    current_run_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS kanban_tasks_board_status ON kanban_tasks (board, status);
  CREATE TABLE IF NOT EXISTS kanban_task_links (
    parent_id TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
    child_id TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (parent_id, child_id)
  );
  CREATE INDEX IF NOT EXISTS kanban_task_links_child ON kanban_task_links (child_id);
  CREATE TABLE IF NOT EXISTS kanban_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
    author TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS kanban_comments_task ON kanban_comments (task_id, created_at);
  CREATE TABLE IF NOT EXISTS kanban_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
    run_id INTEGER,
    kind TEXT NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS kanban_events_task ON kanban_events (task_id, created_at);
  CREATE TABLE IF NOT EXISTS kanban_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
    profile TEXT,
    session_id TEXT,
    status TEXT NOT NULL,
    outcome TEXT,
    summary TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_heartbeat_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS kanban_runs_task ON kanban_runs (task_id, started_at);
  `,
  /**
   * Jarod-cordis (Q18, décision utilisateur 2026-09-28) : état de travail PAR CONVERSATION (SANK-AI
   * `kernel/session-state.js`, MIT — là-bas en mémoire, ici persistant). `value` = JSON ; supprimé avec
   * la conversation. Additive, rejouable, vide : une base v18 reste lisible par la source (v14).
   */
  `
  CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, key)
  );
  `,
  /**
   * Jarod-cordis (PLAN §10 phase 2, lot A ; décision utilisateur 2026-09-29) : documents indexés et repérage de
   * leurs chunks. Deux tables ADDITIVES, rejouables, vides ; `rag_chunks` n'est PAS modifiée (pas d'ALTER : une base
   * v19 reste lisible par la source v14, les index dérivés — mémoire, turbovec — lisent les mêmes lignes).
   * - `rag_documents` : un document = son manifeste (JSON, déterministe), le texte normalisé auquel renvoient les
   *   décalages du manifeste (de quoi rechunker et réindexer SANS relire l'original), les empreintes et le parseur.
   * - `rag_chunk_spans` : où un chunk se trouve dans ce texte (décalages, page, section) ; supprimé avec le chunk.
   */
  `
  CREATE TABLE IF NOT EXISTS rag_documents (
    doc_id TEXT PRIMARY KEY,
    source TEXT,
    parser TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    manifest TEXT NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'indexed',
    at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rag_chunk_spans (
    chunk_id INTEGER PRIMARY KEY REFERENCES rag_chunks(id) ON DELETE CASCADE,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    page INTEGER,
    section TEXT
  );
  `,
  /**
   * Recherche hybride (SPECS-P5-HYBRID.md §2.1) : index lexical FTS5 des passages du RAG, en CONTENU EXTERNE sur `rag_chunks` (aucun texte
   * dupliqué, `rag_chunks` n'est PAS modifiée), tenu à jour par triggers comme `messages_fts` / `memories_fts`. Rejouable : tout est
   * `IF NOT EXISTS` et la reconstruction finale est idempotente (elle rattrape aussi les passages déjà indexés).
   */
  `
  CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(text, content='rag_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
    INSERT INTO rag_chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
    INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE OF text ON rag_chunks BEGIN
    INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO rag_chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  INSERT INTO rag_chunks_fts(rag_chunks_fts) VALUES ('rebuild');
  `,
  /**
   * Jarod-cordis (file 4d, SPECS-P5-AUTOMATION.md) : règles d'automatisation « quand X alors Y ».
   * AJOUTÉE À LA FIN : une migration ne s'insère jamais au milieu du tableau, sinon tous les index
   * suivants sont décalés et une base déjà migrée (user_version = N) ne ré-applique jamais l'entrée
   * insérée (index < N) — la table ne serait jamais créée. Rejouable (IF NOT EXISTS).
   */
  `
  CREATE TABLE IF NOT EXISTS automation_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger TEXT NOT NULL,
    actions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automation_rules_enabled ON automation_rules(enabled);
  `,
  /**
   * H6/M7 (audit v4 § 1) — `ref` : la règle (ou la tâche) à laquelle une exécution appartient, en clair.
   * Avant, le seul lien était le contenu JSON du `payload`, retrouvé par `LIKE '%"ruleId":"…"%'` : un ordre
   * de clés qui change et la recherche ne trouvait plus rien (donc plus de « dernier créneau traité »).
   * AJOUTÉE À LA FIN, et SEULE (une migration à un seul `ALTER` est rejouable, cf. `columnAlreadyAdded`).
   */
  `ALTER TABLE jobs ADD COLUMN ref TEXT;`,
  /** H6/M7 — `started_at` : l'instant de la PRISE (`claim`). `updated_at` bouge aussi aux transitions de statut. */
  `ALTER TABLE jobs ADD COLUMN started_at INTEGER;`,
  `CREATE INDEX IF NOT EXISTS jobs_ref ON jobs(kind, ref, status, due_at);`,
  /**
   * Cockpit, lot 3 (context-mode) : les sorties d'outils VOLUMINEUSES restent hors du contexte, entières, dans la base (chiffrée quand
   * elle l'est) : un aperçu et une référence entrent dans la conversation ; la recherche plein texte rend des extraits exacts (numéros
   * de ligne). Découpées en fenêtres de lignes indexées FTS5. Effacées avec la conversation (par le runtime). Additive, rejouable.
   */
  `
  CREATE TABLE IF NOT EXISTS tool_outputs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    lines INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    preview_chars INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tool_outputs_session ON tool_outputs(session_id, created_at);
  CREATE TABLE IF NOT EXISTS tool_output_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    output_id TEXT NOT NULL REFERENCES tool_outputs(id) ON DELETE CASCADE,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tool_output_chunks_output ON tool_output_chunks(output_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS tool_output_chunks_fts USING fts5(text, content='tool_output_chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER IF NOT EXISTS tool_output_chunks_ai AFTER INSERT ON tool_output_chunks BEGIN
    INSERT INTO tool_output_chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS tool_output_chunks_ad AFTER DELETE ON tool_output_chunks BEGIN
    INSERT INTO tool_output_chunks_fts(tool_output_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  `,
  /**
   * Cockpit, lot 5 (et suivants) : les ARTEFACTS produits par l'agent — diagrammes, vidéos, analyses, rapports. Une ligne = un fichier
   * de l'utilisateur (référencé, jamais copié), son empreinte au moment de l'enregistrement (un fichier modifié depuis se voit), sa
   * source modifiable éventuelle et sa provenance (conversation, outil, tâche). Additive, rejouable.
   */
  `
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    source_path TEXT,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    origin TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS artifacts_created ON artifacts(created_at);
  `,
];

const SQLITE_HEADER = "SQLite format 3\u0000";

function header(path: string): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return n === 16 ? buf.toString("latin1") : null;
  } finally {
    closeSync(fd);
  }
}

/** True when the file is an SQLite database stored in clear. */
export const isPlainDb = (path: string) => header(path) === SQLITE_HEADER;
/** True when the file exists and is not a clear SQLite database (so: encrypted). */
export const isEncryptedDb = (path: string) => {
  const h = header(path);
  return h !== null && h !== SQLITE_HEADER;
};

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Opens a database with an optional key (or password) and checks it can actually be read. */
function openRaw(path: string, key: string | null, nativeBinding?: string, readonly = false): Database.Database {
  const db = new Database(path, { ...(nativeBinding ? { nativeBinding } : {}), ...(readonly ? { readonly: true } : {}) });
  db.pragma("cipher = 'chacha20'");
  if (key !== null) db.pragma(`key = ${quote(key)}`);
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch (e) {
    db.close();
    if ((e as { code?: string }).code === "SQLITE_NOTADB")
      throw new DbKeyError("Clé ou mot de passe incorrect pour cette base.");
    throw e;
  }
  return db;
}

/** Encrypts a clear database in place; restores the original if anything fails. */
function encryptInPlace(path: string, key: string, nativeBinding?: string): void {
  // Fold the WAL into the main file: keys can't be changed in WAL mode.
  const plain = openRaw(path, null, nativeBinding);
  plain.pragma("journal_mode = DELETE");
  plain.close();
  const safety = `${path}.avant-chiffrement`;
  copyFileSync(path, safety);
  try {
    const db = openRaw(path, null, nativeBinding);
    db.pragma(`rekey = ${quote(key)}`);
    db.close();
    openRaw(path, key, nativeBinding).close();
    rmSync(safety);
  } catch (e) {
    copyFileSync(safety, path);
    rmSync(safety, { force: true });
    throw e;
  }
}

/**
 * Re-keys a standalone database file (backups): `from` opens it (null = clear), `to` is the new
 * key or password (null = decrypt).
 */
export function rekeyFile(path: string, from: string | null, to: string, nativeBinding?: string): void {
  if (from === null && isPlainDb(path)) {
    encryptInPlace(path, to, nativeBinding);
    return;
  }
  const db = openRaw(path, from, nativeBinding);
  try {
    db.pragma("journal_mode = DELETE");
    db.pragma(`rekey = ${quote(to)}`);
  } finally {
    db.close();
  }
  openRaw(path, to, nativeBinding).close();
}

/**
 * Sauvegarde externe de Jarod-OS (docs/BACKUP-EXTERNE.md du dépôt) : copie cohérente de `src` (journal WAL compris) dans `dest`,
 * MÊME clé, puis effacement de la table `secrets` de la copie (valeurs du coffre, jetons des fournisseurs) et `VACUUM` pour que les
 * pages libérées ne gardent rien. Les noms et domaines du coffre restent (réglages, sans valeur). La source n'est jamais modifiée :
 * elle est ouverte en lecture seule ; le moteur doit être arrêté pendant l'appel. Rend le nombre de valeurs retirées.
 */
export function snapshotWithoutSecrets(src: string, dest: string, key: string | null, nativeBinding?: string): { removed: number } {
  if (existsSync(dest)) throw new Error(`destination déjà présente : ${dest}`);
  const source = openRaw(src, key, nativeBinding, true);
  try {
    source.prepare("VACUUM INTO ?").run(dest);
  } finally {
    source.close();
  }
  // Selon la version du chiffrement, VACUUM INTO écrit la copie chiffrée avec la même clé, ou en clair : elle est remise à la clé de la source.
  if (key !== null && isPlainDb(dest)) encryptInPlace(dest, key, nativeBinding);
  const copy = openRaw(dest, key, nativeBinding);
  try {
    copy.pragma("journal_mode = DELETE");
    const removed = Number((copy.prepare("SELECT count(*) AS n FROM secrets").get() as { n: number }).n);
    copy.prepare("DELETE FROM secrets").run();
    copy.exec("VACUUM");
    return { removed };
  } finally {
    copy.close();
  }
}

/**
 * Jarod-cordis (Q14, restauration) : ouvre un fichier de base isolé avec cette clé (null = en clair), vérifie
 * `quick_check` et rend sa version. Clé fausse → `DbKeyError` ; base abîmée → erreur. Aucune écriture.
 */
export function checkDbFile(path: string, key: string | null, nativeBinding?: string): { userVersion: number } {
  const db = openRaw(path, key, nativeBinding);
  try {
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`base abîmée (quick_check=${String(check)})`);
    return { userVersion: Number(db.pragma("user_version", { simple: true })) };
  } finally {
    db.close();
  }
}

/**
 * SPECS-P5-CLI.md (`jarod health`) : ouvre un fichier de base EN LECTURE SEULE (aucune migration, aucune écriture, aucune clé créée), vérifie
 * `quick_check`, rend la version du schéma et le réglage `ecosystem` (null s'il n'existe pas ou n'est pas du JSON). Clé fausse → `DbKeyError` ;
 * base abîmée → erreur.
 */
export function inspectDbFile(
  path: string,
  key: string | null,
  nativeBinding?: string,
  /** Réglages à lire en plus (liste BLANCHE : aucun autre n'est lu ni rendu). */
  settingKeys: string[] = [],
): { userVersion: number; ecosystem: unknown; settings: Record<string, unknown> } {
  const db = openRaw(path, key, nativeBinding, true);
  try {
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") throw new Error(`base abîmée (quick_check=${String(check)})`);
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    let ecosystem: unknown = null;
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'ecosystem'").get() as { value: string } | undefined;
      ecosystem = row ? JSON.parse(row.value) : null;
    } catch {
      ecosystem = null;
    }
    const settings: Record<string, unknown> = {};
    for (const k of settingKeys) {
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | undefined;
        if (row) settings[k] = JSON.parse(row.value);
      } catch {
        /* valeur absente ou illisible : ignorée */
      }
    }
    return { userVersion, ecosystem, settings };
  } finally {
    db.close();
  }
}

export interface DbOptions {
  /** Encryption key; null keeps (or opens) a clear database. */
  key?: string | null;
  /** Path to the native SQLite addon (packaged app). */
  nativeBinding?: string;
  /**
   * Jarod-cordis (Q10) : sauvegarde horodatée d'une base EXISTANTE avant toute migration (défaut : oui) —
   * `<dossier>/backups/<nom>.v<avant>-avant-v<après>.<horodatage>.bak`, même clé, vérifiée avant de migrer.
   */
  backupBeforeMigrate?: boolean;
}

export class Db {
  private readonly raw: Database.Database;
  readonly encrypted: boolean;
  /** Sauvegarde faite avant la migration de cette ouverture (null : aucune migration d'une base existante). */
  migrationBackup: string | null = null;

  constructor(
    private readonly path: string,
    private readonly opts: DbOptions = {},
  ) {
    const key = opts.key ?? null;
    if (key !== null && isPlainDb(path)) encryptInPlace(path, key, opts.nativeBinding);
    this.raw = openRaw(path, key, opts.nativeBinding);
    this.encrypted = key !== null;
    // Une mort brutale laisse des transactions validées dans le `-wal`, donc hors du fichier principal
    // (et, pour une base en clair, lisibles sur le disque). SQLite sait les rejouer ; on les replie tout
    // de suite pour qu'une disparition des compagnons ne perde plus rien.
    if (existsSync(`${path}-wal`)) this.checkpoint();
    // Le chiffrement recopie la base EN CLAIR dans `<chemin>.avant-chiffrement` avant de la ré-encrypter :
    // une mort du processus entre les deux laissait cette copie derrière elle, pour toujours. Le fichier
    // principal vient de s'ouvrir, donc la migration a abouti et la copie est redondante — c'est le seul
    // moment où on peut la supprimer sans risquer de jeter la seule donnée intacte.
    rmSync(`${path}.avant-chiffrement`, { force: true });
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    try {
      this.migrate();
    } catch (e) {
      // Jarod-cordis : une migration refusée ne laisse pas la base ouverte (fichier verrouillé sous Windows).
      this.raw.close();
      throw e;
    }
  }

  private migrate(): void {
    const current = this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
    if (current > 0 && current < MIGRATIONS.length && this.opts.backupBeforeMigrate !== false) this.backupBeforeMigrate(current);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        if (!this.columnAlreadyAdded(MIGRATIONS[v]!)) this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /**
   * Jarod-cordis (Q10) : une migration faite d'UN SEUL `ALTER TABLE t ADD COLUMN c …` est sans effet sur une base
   * qui a déjà la colonne — une migration doit pouvoir être rejouée (réparation, `user_version` ramenée en
   * arrière), et SQLite n'a pas de ADD COLUMN IF NOT EXISTS.
   */
  private columnAlreadyAdded(sql: string): boolean {
    const m = /^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)\b[^;]*;\s*$/i.exec(sql);
    if (!m) return false;
    return this.all<{ name: string }>("SELECT name FROM pragma_table_info(?)", m[1]!).some((c) => c.name === m[2]);
  }

  /**
   * Jarod-cordis (Q10) : copie cohérente (`VACUUM INTO` : instantané de lecture, même chiffrement, WAL replié)
   * de la base AVANT migration, puis rouverte avec la même clé : intègre (`quick_check`) et à la version de
   * départ. Sinon la migration n'a pas lieu (la base reste intacte) — jamais de migration sans sauvegarde.
   */
  private backupBeforeMigrate(from: number): void {
    if (this.path === ":memory:" || this.path === "") return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(dirname(this.path), "backups");
    const file = join(dir, `${basename(this.path)}.v${from}-avant-v${MIGRATIONS.length}.${stamp}.bak`);
    try {
      mkdirSync(dir, { recursive: true });
      this.raw.prepare("VACUUM INTO ?").run(file);
      this.verifyCopy(file, from);
    } catch (e) {
      throw new Error(`Migration v${from} → v${MIGRATIONS.length} annulée : sauvegarde préalable impossible (${file}) : ${(e as Error).message}`);
    }
    this.migrationBackup = file;
  }

  /** Rouvre une copie avec la même clé : intègre (`quick_check`) et à la version attendue, sinon lève. */
  private verifyCopy(file: string, expected: number): void {
    const b = openRaw(file, this.opts.key ?? null, this.opts.nativeBinding);
    try {
      const check = b.pragma("quick_check", { simple: true });
      const version = b.pragma("user_version", { simple: true });
      if (check !== "ok" || version !== expected) throw new Error(`sauvegarde invalide (quick_check=${String(check)}, user_version=${String(version)})`);
    } finally {
      b.close();
    }
  }

  /**
   * Jarod-cordis (Q13-2, sauvegarde complète du profil) : instantané cohérent (`VACUUM INTO`) chiffré avec la
   * MÊME clé que la base (jamais de copie en clair), rouvert et vérifié (intègre, même version) ; destination
   * existante refusée, copie invalide supprimée. Rend la version du schéma sauvegardé.
   */
  snapshotTo(path: string): { userVersion: number } {
    if (existsSync(path)) throw new Error(`destination déjà présente : ${path}`);
    const userVersion = this.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
    this.raw.prepare("VACUUM INTO ?").run(path);
    try {
      this.verifyCopy(path, userVersion);
    } catch (e) {
      rmSync(path, { force: true });
      throw e;
    }
    return { userVersion };
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  /** Execute raw SQL (multiple statements, no parameters). */
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Jarod-cordis (U3, G11) : `BEGIN IMMEDIATE` au lieu de `BEGIN` (source db.ts:446). Une transaction
   * différée qui lit puis écrit, face à un second processus, échoue AUSSITÔT au passage en écriture
   * (SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT : busy_timeout ne s'applique pas) — mesuré : 289 transactions
   * sur 600 perdues en 0,3 s (`tests/integration/sqlite-contention.test.ts`). Le verrou d'écriture pris
   * dès le début passe par busy_timeout (5 s) : l'attente remplace l'échec.
   */
  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * Consistent snapshot of the whole database into a new file. An encrypted database must be backed
   * up with a password: its own key is tied to this user account and would be lost with the machine.
   */
  backupTo(path: string, password?: string): void {
    if (this.encrypted && !password) throw new Error("Choisissez un mot de passe pour protéger la sauvegarde.");
    if (existsSync(path)) rmSync(path);
    this.raw.prepare("VACUUM INTO ?").run(path);
    if (password) rekeyFile(path, this.opts.key ?? null, password, this.opts.nativeBinding);
  }

  /**
   * Replie le journal (`-wal`) dans le fichier principal. Rend `false` quand une autre connexion le
   * retient encore : le journal reste alors en place, il ne faut surtout pas le supprimer.
   */
  private checkpoint(): boolean {
    try {
      const res = this.raw.pragma("wal_checkpoint(TRUNCATE)") as { busy?: number } | undefined;
      return !(res?.busy ?? 0);
    } catch {
      // Base déjà fermée ou verrouillée : la fermeture reste la priorité.
      return false;
    }
  }

  close(): void {
    // Replier le journal avant de fermer : un checkpoint occupé laisse des transactions validées
    // DANS le `-wal`, et la fermeture ne doit ni les perdre ni les supprimer à la main — un autre
    // processus peut tenir le journal ouvert (Windows refuse alors l'effacement, EPERM ; POSIX
    // l'accepterait et ferait perdre les données du voisin). Le checkpoint de l'ouverture suivant
    // repliera ce qui reste.
    this.checkpoint();
    this.raw.close();
  }
}

/** Turns free user text into a safe FTS5 query: each word becomes a quoted prefix term. */
export function ftsQuery(text: string, mode: "and" | "or" = "and"): string | null {
  const terms = text
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 16)
    .map((t) => `"${t.replace(/"/g, "")}"*`);
  if (terms.length === 0) return null;
  return terms.join(mode === "and" ? " " : " OR ");
}
