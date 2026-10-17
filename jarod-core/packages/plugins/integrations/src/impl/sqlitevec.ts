/**
 * B2 — le moteur réel : sqlite-vec (extension `vec0`) chargé dans une base better-sqlite3-multiple-ciphers.
 * `probe` est le PoC d'ABI : charger l'extension et lire `vec_version()`. Tout échec fait retomber `openVecIndex` sur
 * le repli exact, avec la raison.
 */
import { AdapterRefused } from "./common.js";
import type { VecExtension, VecHit, VecIndex } from "./embeddings.js";

export interface VecDb {
  loadExtension(path: string): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
}

const TABLE = /^[a-z_][a-z0-9_]{0,40}$/;

const blob = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);

class SqliteVecIndex implements VecIndex {
  readonly kind = "sqlite-vec" as const;
  constructor(private readonly db: VecDb, private readonly table: string, private readonly dimensions: number) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(id TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
  }
  private check(v: number[]): void {
    if (v.length !== this.dimensions || v.some((x) => !Number.isFinite(x))) throw new AdapterRefused("B2", `vecteur invalide (dimension ${v.length}, attendu ${this.dimensions})`);
  }
  add(id: string, vector: number[]): void {
    this.check(vector);
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    this.db.prepare(`INSERT INTO ${this.table}(id, embedding) VALUES (?, ?)`).run(id, blob(vector));
  }
  search(vector: number[], k: number): VecHit[] {
    this.check(vector);
    const limit = Math.max(0, Math.min(1000, Math.floor(k)));
    if (limit === 0) return [];
    const rows = this.db.prepare(`SELECT id, distance FROM ${this.table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`).all(blob(vector), limit) as { id: string; distance: number }[];
    return rows.map((r) => ({ id: r.id, score: 1 - r.distance }));
  }
  remove(id: string): void {
    this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
  }
  size(): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM ${this.table}`).get() as { n: number }).n;
  }
}

export function sqliteVecExtension(db: VecDb, loadablePath: string, table = "jarod_vec"): VecExtension {
  if (!TABLE.test(table)) throw new AdapterRefused("B2", "nom de table invalide");
  return {
    probe() {
      db.loadExtension(loadablePath);
      const row = db.prepare("SELECT vec_version() AS v").get() as { v?: string } | undefined;
      return { version: row?.v ?? "" };
    },
    open: (dimensions) => new SqliteVecIndex(db, table, dimensions),
  };
}
