/**
 * R4 (Temporal, concepts seulement) — exécutions durables minimales sur SQLite.
 *
 * Reprend trois idées de Temporal sans serveur ni dépendance : (1) une exécution a un historique d'événements ordonné ;
 * (2) une ACTIVITÉ identifiée par sa clé n'est exécutée qu'une fois, son résultat est rejoué depuis l'historique à la
 * reprise ; (3) les échecs sont comptés par activité et plafonnés. Le déroulé du workflow doit être déterministe (mêmes
 * clés dans le même ordre) : une divergence à la reprise est une erreur, pas un silence.
 * Les résultats sont du JSON borné ; un résultat sensible doit être masqué par l'appelant (`redact`) avant d'être écrit.
 */
import { AdapterRefused } from "./common.js";

export interface DurableDb {
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
  run(sql: string, ...params: (string | number | null)[]): unknown;
  exec(sql: string): void;
}

export type RunStatus = "running" | "completed" | "failed";

export interface RunEvent {
  seq: number;
  key: string;
  kind: "completed" | "failed";
  payload: unknown;
}

export interface ActivityOptions {
  maxAttempts?: number;
  /** Rendu au résultat avant l'écriture dans l'historique (masquage). Le résultat rendu à l'appelant reste le brut. */
  redact?: (value: unknown) => unknown;
}

const MAX_PAYLOAD = 1_000_000;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;

export class DurableRuns {
  constructor(private readonly db: DurableDb, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS durable_runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS durable_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (run_id, seq))`);
  }

  start(id: string, workflow: string, input: unknown): void {
    if (!KEY.test(id) || !KEY.test(workflow)) throw new AdapterRefused("R4", "identifiant invalide");
    if (this.db.all("SELECT id FROM durable_runs WHERE id = ?", id).length) throw new AdapterRefused("R4", `exécution ${id} déjà démarrée`);
    this.db.run("INSERT INTO durable_runs (id, workflow, input, status, created_at) VALUES (?, ?, ?, 'running', ?)", id, workflow, this.json(input), this.now());
  }

  status(id: string): { status: RunStatus; workflow: string; result: unknown } | null {
    const r = this.db.all<{ status: RunStatus; workflow: string; result: string | null }>("SELECT status, workflow, result FROM durable_runs WHERE id = ?", id)[0];
    return r ? { status: r.status, workflow: r.workflow, result: r.result === null ? undefined : JSON.parse(r.result) } : null;
  }

  history(id: string): RunEvent[] {
    return this.db
      .all<{ seq: number; key: string; kind: "completed" | "failed"; payload: string }>("SELECT seq, key, kind, payload FROM durable_events WHERE run_id = ? ORDER BY seq", id)
      .map((e) => ({ seq: e.seq, key: e.key, kind: e.kind, payload: JSON.parse(e.payload) }));
  }

  private json(v: unknown): string {
    const s = JSON.stringify(v === undefined ? null : v);
    if (s.length > MAX_PAYLOAD) throw new AdapterRefused("R4", "charge utile trop grande");
    return s;
  }

  private append(id: string, key: string, kind: "completed" | "failed", payload: unknown): void {
    const seq = (this.db.all<{ n: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM durable_events WHERE run_id = ?", id)[0]?.n ?? 1) as number;
    this.db.run("INSERT INTO durable_events (run_id, seq, key, kind, payload) VALUES (?, ?, ?, ?, ?)", id, seq, key, kind, this.json(payload));
  }

  /** Exécute `workflow` ; une activité déjà terminée est rejouée depuis l'historique, jamais ré-exécutée. */
  async run<T>(id: string, workflow: (ctx: DurableContext) => Promise<T>): Promise<T> {
    const st = this.status(id);
    if (!st) throw new AdapterRefused("R4", `exécution ${id} inconnue`);
    if (st.status === "completed") return st.result as T;
    const done = new Map<string, unknown>();
    for (const e of this.history(id)) if (e.kind === "completed") done.set(e.key, e.payload);
    const seen = new Set<string>();
    const ctx: DurableContext = {
      activity: async <A>(key: string, fn: () => Promise<A>, opts: ActivityOptions = {}): Promise<A> => {
        if (!KEY.test(key)) throw new AdapterRefused("R4", "clé d'activité invalide");
        if (seen.has(key)) throw new AdapterRefused("R4", `clé d'activité en double : ${key} (le déroulé doit être déterministe)`);
        seen.add(key);
        if (done.has(key)) return done.get(key) as A;
        const max = Math.max(1, opts.maxAttempts ?? 3);
        const failed = this.history(id).filter((e) => e.key === key && e.kind === "failed").length;
        if (failed >= max) throw new AdapterRefused("R4", `activité ${key} : ${failed} échecs, plafond atteint`);
        try {
          const out = await fn();
          this.append(id, key, "completed", opts.redact ? opts.redact(out) : out);
          done.set(key, out);
          return out;
        } catch (e) {
          if (e instanceof AdapterRefused) throw e;
          this.append(id, key, "failed", { error: (e as Error).message.slice(0, 300) });
          throw e;
        }
      },
    };
    try {
      const result = await workflow(ctx);
      this.db.run("UPDATE durable_runs SET status = 'completed', result = ? WHERE id = ?", this.json(result), id);
      return result;
    } catch (e) {
      const failedKeys = this.history(id).filter((x) => x.kind === "failed").length;
      if (failedKeys >= 1 && e instanceof AdapterRefused) this.db.run("UPDATE durable_runs SET status = 'failed' WHERE id = ?", id);
      throw e;
    }
  }
}

export interface DurableContext {
  activity<A>(key: string, fn: () => Promise<A>, opts?: ActivityOptions): Promise<A>;
}
