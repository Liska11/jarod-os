/**
 * GATE P0 (PLAN §6) — « App démarre, DB WAL chiffrée migrée, cron persiste à travers redémarrage ».
 *
 * Données réelles, jamais en place : `backup-db/jarod.db` et le blob DPAPI de sa clé (lu dans le
 * dataDir d'origine, lecture seule) sont COPIÉS dans `.work/gate-p0/<horodatage>/`. Rien n'est écrit
 * ailleurs. Aucune simulation : vrais plugins, vrai kernel, vraie horloge.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScheduleDto } from "@jarod/contracts";
import { JarodApp, start, stop } from "@jarod/kernel";
import { defaultKeyStores, isEncryptedDb, MIGRATIONS } from "@jarod/plugin-storage";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DB = join(ROOT, "backup-db", "jarod.db");
const SOURCE_KEY =
  process.env.JAROD_P0_KEYFILE ??
  join(process.env.APPDATA ?? "", "Jarod-One", "data", "profiles", "default", "db.key.dpapi");
const WORK = join(ROOT, ".work", "gate-p0", new Date().toISOString().replace(/[:.]/g, "-"));

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/** Un profil de travail : copie de la base + copie du blob de clé (chiffré DPAPI, jamais en clair). */
function copyProfile(name: string): string {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(SOURCE_DB, join(dir, "jarod.db"));
  copyFileSync(SOURCE_KEY, join(dir, "db.key.dpapi"));
  return dir;
}

interface Snapshot {
  userVersion: number;
  integrity: string;
  tables: Record<string, { rows: number; sha256: string }>;
  /** Colonnes de chaque table, dans l'ordre du schéma. */
  columns: Record<string, string[]>;
}

/**
 * État complet d'une base : version, intégrité, et pour CHAQUE table son nombre de lignes + empreinte.
 * `columnsOf` (Q10, migrations ADDITIVES) : empreinte calculée sur ces colonnes seulement (celles d'avant la
 * migration) — une colonne ajoutée est vérifiée à part, les données existantes doivent être identiques.
 */
function snapshot(path: string, key: string, columnsOf?: Record<string, string[]>): Snapshot {
  const raw = new Database(path, { readonly: true });
  try {
    raw.pragma("cipher = 'chacha20'");
    raw.pragma(`key = '${key.replace(/'/g, "''")}'`);
    const userVersion = raw.pragma("user_version", { simple: true }) as number;
    const integrity = raw.pragma("integrity_check", { simple: true }) as string;
    const tables: Snapshot["tables"] = {};
    const columns: Snapshot["columns"] = {};
    const names = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    for (const { name } of names) {
      const q = `"${name.replace(/"/g, '""')}"`;
      columns[name] = (raw.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as { name: string }[]).map((c) => c.name);
      const cols = columnsOf?.[name] ? columnsOf[name]!.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ") : "*";
      let rows: unknown[];
      try {
        rows = raw.prepare(`SELECT ${cols} FROM ${q} ORDER BY rowid`).all();
      } catch {
        rows = raw.prepare(`SELECT ${cols} FROM ${q}`).all();
      }
      tables[name] = { rows: rows.length, sha256: sha256(JSON.stringify(rows)) };
    }
    return { userVersion, integrity, tables, columns };
  } finally {
    raw.close();
  }
}

const report: string[] = [];
const log = (line: string) => {
  report.push(line);
  console.log(`[gate-p0] ${line}`);
};

describe("GATE P0", () => {
  it("préconditions : copie de la base identique à l'origine, clé disponible", () => {
    expect(existsSync(SOURCE_DB), `base absente : ${SOURCE_DB}`).toBe(true);
    expect(existsSync(SOURCE_KEY), `blob de clé absent : ${SOURCE_KEY}`).toBe(true);
    expect(isEncryptedDb(SOURCE_DB)).toBe(true);
    log(`source ${SOURCE_DB} sha256=${sha256(readFileSync(SOURCE_DB)).slice(0, 16)}…`);
  });

  it("1+2 — la base existante est migrée par le kernel sans aucune perte (copie)", async () => {
    const reference = copyProfile("reference");
    const migrated = copyProfile("migrated");
    const sourceHashBefore = sha256(readFileSync(SOURCE_DB));
    const key = defaultKeyStores()[0]!.load(reference);
    expect(key, "clé DPAPI illisible pour ce compte").toBeTruthy();

    const before = snapshot(join(reference, "jarod.db"), key!);
    log(`avant : user_version=${before.userVersion} integrity=${before.integrity} tables=${Object.keys(before.tables).length}`);
    for (const [t, s] of Object.entries(before.tables)) if (s.rows) log(`  ${t}: ${s.rows}`);

    // La migration = ouverture par le plugin-storage porté (Db : chiffrement, WAL, migrate()).
    const app = new JarodApp({ plugins: { storage: { dataDir: migrated } } });
    const started = await start(app);
    const storage = (
      app as unknown as { storage: { db: { encrypted: boolean; migrationBackup: string | null }; dbEncryption: { keyStore: string } } }
    ).storage;
    expect(storage.db.encrypted).toBe(true);
    const backup = storage.db.migrationBackup;
    log(`kernel : plugins=${started.loaded.map((p) => p.name).join(",")} clé=${storage.dbEncryption.keyStore}`);
    await stop(started);

    const after = snapshot(join(migrated, "jarod.db"), key!, before.columns);
    log(`après : user_version=${after.userVersion} integrity=${after.integrity}`);
    expect(after.integrity).toBe("ok");
    expect(after.userVersion).toBe(MIGRATIONS.length);
    // Aucune table perdue, aucune ligne perdue ni modifiée (sur les colonnes d'avant la migration).
    for (const [t, s] of Object.entries(before.tables)) {
      expect(after.tables[t], `table disparue : ${t}`).toBeDefined();
      expect(after.tables[t], `table modifiée : ${t}`).toEqual(s);
      expect(after.columns[t]!.slice(0, before.columns[t]!.length), `colonnes d'origine changées : ${t}`).toEqual(before.columns[t]);
    }
    const added = Object.keys(after.tables).filter((t) => !before.tables[t]);
    log(`tables ajoutées par migration : ${added.length ? added.join(",") : "aucune"}`);
    const addedCols = Object.entries(after.columns).flatMap(([t, cols]) => (before.columns[t] ? cols.slice(before.columns[t]!.length).map((c) => `${t}.${c}`) : []));
    log(`colonnes ajoutées par migration : ${addedCols.length ? addedCols.join(",") : "aucune"}`);
    // Q10 : colonne additive `sessions.model_pinned` — toutes les conversations existantes à 0 (« suit le modèle actif »).
    if (before.userVersion < MIGRATIONS.length && before.userVersion < 15 && after.userVersion >= 15) {
      expect(addedCols).toContain("sessions.model_pinned");
      const raw = new Database(join(migrated, "jarod.db"), { readonly: true });
      raw.pragma("cipher = 'chacha20'");
      raw.pragma(`key = '${key!.replace(/'/g, "''")}'`);
      const pins = raw.prepare("SELECT model_pinned AS v, COUNT(*) AS n FROM sessions GROUP BY model_pinned").all();
      raw.close();
      log(`sessions.model_pinned : ${JSON.stringify(pins)}`);
      expect(pins).toEqual(before.tables.sessions!.rows ? [{ v: 0, n: before.tables.sessions!.rows }] : []);
    }
    // Q13-1 : migration v16 additive — deux tables ajoutées, vides (rien n'est déduit des données existantes).
    if (before.userVersion < 16 && after.userVersion >= 16) {
      expect(added).toEqual(expect.arrayContaining(["session_continuations", "session_local_errors"]));
      expect(after.tables.session_continuations?.rows).toBe(0);
      expect(after.tables.session_local_errors?.rows).toBe(0);
    }
    // Q17 : migration v17 additive (plugin-kanban) — six tables ajoutées, vides (aucune donnée Kanban reprise).
    if (before.userVersion < 17 && after.userVersion >= 17) {
      const kanban = ["kanban_boards", "kanban_comments", "kanban_events", "kanban_runs", "kanban_task_links", "kanban_tasks"];
      expect(added).toEqual(expect.arrayContaining(kanban));
      for (const t of kanban) expect(after.tables[t]?.rows, t).toBe(0);
      log(`Q17 : tables kanban ajoutées vides : ${kanban.join(",")}`);
    }
    // Q18 : migration v18 additive — état de travail par conversation, table ajoutée vide.
    if (before.userVersion < 18 && after.userVersion >= 18) {
      expect(added).toContain("session_state");
      expect(after.tables.session_state?.rows).toBe(0);
      log("Q18 : table session_state ajoutée vide");
    }
    // Ingestion, lot A : migration v19 additive — documents et repérage des chunks, deux tables ajoutées vides ;
    // `rag_chunks` n'est pas modifiée (aucune colonne ajoutée : les colonnes et les lignes sont comparées plus haut).
    if (before.userVersion < 19 && after.userVersion >= 19) {
      expect(added).toEqual(expect.arrayContaining(["rag_documents", "rag_chunk_spans"]));
      expect(after.tables.rag_documents?.rows).toBe(0);
      expect(after.tables.rag_chunk_spans?.rows).toBe(0);
      expect(addedCols.filter((c) => c.startsWith("rag_chunks."))).toEqual([]);
      log("lot A : tables rag_documents et rag_chunk_spans ajoutées vides ; rag_chunks inchangée");
    }
    // Q10 : sauvegarde horodatée prise AVANT la migration = exactement l'état d'avant (même clé).
    if (before.userVersion < MIGRATIONS.length) {
      expect(backup, "aucune sauvegarde avant migration").toBeTruthy();
      expect(existsSync(backup!)).toBe(true);
      const saved = snapshot(backup!, key!);
      log(`sauvegarde avant migration : ${backup} user_version=${saved.userVersion} integrity=${saved.integrity}`);
      expect(saved.userVersion).toBe(before.userVersion);
      expect(saved.integrity).toBe("ok");
      expect(saved.tables).toEqual(before.tables);
      expect(saved.columns).toEqual(before.columns);
    }
    // L'origine n'a pas bougé d'un octet.
    expect(sha256(readFileSync(SOURCE_DB))).toBe(sourceHashBefore);
  });

  it("1 — l'app démarre en processus réel sur la base migrée", () => {
    const profile = copyProfile("boot");
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "packages/kernel/src/main.ts"), profile], {
      cwd: join(ROOT, "packages/kernel"),
      env: { ...process.env, JAROD_EXIT_AFTER_BOOT: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.trim().split("\n").at(-1)!;
    const state = JSON.parse(line) as { ready: boolean; plugins: string[]; encrypted: boolean };
    log(`boot processus : ${line}`);
    expect(state).toMatchObject({ ready: true, plugins: ["storage", "scheduler"], encrypted: true });
  });

  it("3 — un cron survit à un redémarrage : manqué pendant l'arrêt, tiré au démarrage suivant", async () => {
    const profile = copyProfile("cron");
    const boot = async (fired: ScheduleDto[]) => {
      const app = new JarodApp({ plugins: { storage: { dataDir: profile }, scheduler: { tickMs: 1_000 } } });
      app.on("schedule/run" as never, ((s: ScheduleDto) => {
        fired.push(s);
        return { sessionId: "gate-p0", ok: true, summary: "tir" };
      }) as never);
      const started = await start(app);
      return { app: app as unknown as { scheduler: SchedulerLike; jobs: JobsLike }, started };
    };

    // Premier démarrage : création d'un vrai cron (chaque minute), puis arrêt AVANT l'échéance.
    const firedA: ScheduleDto[] = [];
    const a = await boot(firedA);
    const created = a.app.scheduler.save({ name: "gate-p0", prompt: "ping", spec: { kind: "cron", expr: "* * * * *" } });
    const due = created.nextRun!;
    log(`cron créé ${created.id} prochaine échéance ${new Date(due).toISOString()}`);
    await stop(a.started);
    expect(firedA).toHaveLength(0);

    // L'app est arrêtée pendant que l'échéance passe (horloge réelle, ≤ 60 s).
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now()) + 1_500));

    // Second démarrage (nouvelle instance, base rouverte) : le tir manqué part au démarrage.
    const firedB: ScheduleDto[] = [];
    const b = await boot(firedB);
    for (let i = 0; i < 50 && !b.app.scheduler.get(created.id)?.lastStatus; i++) await new Promise((r) => setTimeout(r, 100));
    const s = b.app.scheduler.get(created.id)!;
    log(`après redémarrage : tirs=${firedB.length} last_run=${s.lastRun} status=${s.lastStatus} next=${s.nextRun}`);
    expect(firedB.map((x) => x.id)).toEqual([created.id]);
    expect(s.lastStatus).toBe("ok");
    expect(s.lastRun!).toBeGreaterThanOrEqual(due);
    expect(s.nextRun!).toBeGreaterThan(s.lastRun!);
    // Le tir est tracé dans la file durable, clos « done ».
    const jobs = b.app.jobs.list().filter((j) => j.kind === "schedule");
    expect(jobs.map((j) => j.status)).toEqual(["done"]);
    await stop(b.started);
    log("GATE P0 : verte");
    writeFileSync(join(WORK, "report.txt"), `${report.join("\n")}\n`);
  });
});

interface SchedulerLike {
  save(input: { name: string; prompt: string; spec: ScheduleDto["spec"] }): ScheduleDto;
  get(id: string): ScheduleDto | undefined;
}
interface JobsLike {
  list(): { kind: string; status: string }[];
}
