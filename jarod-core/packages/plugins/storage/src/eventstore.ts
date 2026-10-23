import type { Db } from "./db.js";

/** One entry of the append-only log. `seq` is global and monotonic: it gives a total order. */
export interface StoredEvent {
  seq: number;
  stream: string;
  type: string;
  data: unknown;
  at: number;
}

export interface EventFilter {
  stream?: string;
  type?: string;
  /** Only entries with a strictly greater seq — lets a subscriber resume where it stopped. */
  after?: number;
  limit?: number;
  /** The LAST `limit` entries instead of the first ones, still returned in seq order (a journal read from its end). */
  newest?: boolean;
}

export interface StreamSummary {
  stream: string;
  events: number;
  lastSeq: number;
  lastAt: number;
}

export interface EventStoreStats {
  enabled: boolean;
  events: number;
  streams: number;
  dropped: number;
  lastError: string | null;
  /** Subscribers that threw. Counted apart: a broken reader says nothing about the log itself. */
  listenerErrors: number;
}

export interface EventStoreOptions {
  /** How many entries the log keeps; the oldest go first. */
  keep?: number;
  /** How often (in appends) the bound is enforced while the app runs. */
  pruneEvery?: number;
}

const DEFAULT_LIMIT = 500;

/**
 * Append-only event log, written in the shadow of the relational state.
 *
 * The tables (`sessions`, `messages`, …) remain the source of truth: nothing reads its behaviour
 * back from this log, it only records what happened so a turn can be replayed, audited or streamed
 * to another process. `append` therefore never throws — losing a journal entry must not fail a
 * conversation. Failures are counted and surfaced through `stats`, which `jarod health` reports,
 * instead of being swallowed twice.
 */
export class EventStoreService {
  private readonly listeners = new Set<(event: StoredEvent) => void>();
  private dropped = 0;
  private lastError: string | null = null;
  private listenerErrors = 0;
  private sincePrune = 0;
  private readonly keep: number;
  private readonly pruneEvery: number;

  /**
   * Every streamed chunk of every answer is an entry: without a bound the log would grow for as long
   * as the profile lives. It is enforced at startup and every `pruneEvery` appends — a desktop app
   * left in the tray for weeks never restarts to do it.
   */
  constructor(
    private readonly db: Db,
    options: EventStoreOptions = {},
  ) {
    this.keep = options.keep ?? 100_000;
    this.pruneEvery = options.pruneEvery ?? 1_000;
    this.bound();
  }

  /** Enforces the bound. Never throws: a log that cannot be trimmed is still a log. */
  private bound(): void {
    try {
      this.prune(this.keep);
    } catch {
      // The next append reports a broken table; trimming has nothing to add.
    }
  }

  get enabled(): boolean {
    return this.lastError === null;
  }

  /** Appends one entry and returns it, or null if the log is unavailable. Never throws. */
  append(stream: string, type: string, data: unknown = {}): StoredEvent | null {
    if (!this.enabled) return null;
    let event: StoredEvent | null = null;
    try {
      const at = Date.now();
      this.db.run(
        "INSERT INTO events (stream, type, data, at) VALUES (?, ?, ?, ?)",
        stream,
        type,
        JSON.stringify(data ?? {}),
        at,
      );
      // Same synchronous connection: no other writer can slip in between.
      const row = this.db.get<{ seq: number }>("SELECT last_insert_rowid() AS seq");
      event = { seq: row?.seq ?? 0, stream, type, data: data ?? {}, at };
      if (++this.sincePrune >= this.pruneEvery) {
        this.sincePrune = 0;
        this.bound();
      }
    } catch (e) {
      this.dropped += 1;
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
    for (const listener of this.listeners) {
      // A subscriber must not be able to break the caller that produced the event — nor the log:
      // recording its error as the log's own would switch the log off for good.
      try {
        listener(event);
      } catch {
        this.listenerErrors += 1;
      }
    }
    return event;
  }

  list(filter: EventFilter = {}): StoredEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.stream) {
      where.push("stream = ?");
      params.push(filter.stream);
    }
    if (filter.type) {
      where.push("type = ?");
      params.push(filter.type);
    }
    if (filter.after !== undefined) {
      where.push("seq > ?");
      params.push(filter.after);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter.limit ?? DEFAULT_LIMIT, 10_000));
    const rows = this.db.all<{ seq: number; stream: string; type: string; data: string; at: number }>(
      `SELECT seq, stream, type, data, at FROM events ${clause} ORDER BY seq ${filter.newest ? "DESC" : "ASC"} LIMIT ${limit}`,
      ...params,
    );
    if (filter.newest) rows.reverse();
    return rows.map((row) => ({ ...row, data: parsePayload(row.data) }));
  }

  /** One row per stream, most recently touched first. */
  streams(): StreamSummary[] {
    return this.db.all<StreamSummary>(
      `SELECT stream, COUNT(*) AS events, MAX(seq) AS lastSeq, MAX(at) AS lastAt
       FROM events GROUP BY stream ORDER BY lastSeq DESC`,
    );
  }

  /** Live tail. Returns the unsubscribe function. */
  subscribe(listener: (event: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops the oldest entries, keeping the log bounded. Returns how many were removed. */
  prune(keep = 100_000): number {
    const { changes } = this.db.run(
      "DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)",
      keep,
    );
    return changes;
  }

  /** Removes one stream entirely (a deleted conversation). Returns how many entries went. */
  forget(stream: string): number {
    try {
      return this.db.run("DELETE FROM events WHERE stream = ?", stream).changes;
    } catch {
      return 0;
    }
  }

  /** Always answers: `jarod health` reports a broken log, it must not be killed by it. */
  stats(): EventStoreStats {
    if (!this.enabled) {
      return {
        enabled: false,
        events: 0,
        streams: 0,
        dropped: this.dropped,
        lastError: this.lastError,
        listenerErrors: this.listenerErrors,
      };
    }
    try {
      const row = this.db.get<{ events: number; streams: number }>(
        "SELECT COUNT(*) AS events, COUNT(DISTINCT stream) AS streams FROM events",
      );
      return {
        enabled: true,
        events: row?.events ?? 0,
        streams: row?.streams ?? 0,
        dropped: this.dropped,
        lastError: this.lastError,
        listenerErrors: this.listenerErrors,
      };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return {
        enabled: false,
        events: 0,
        streams: 0,
        dropped: this.dropped,
        lastError: this.lastError,
        listenerErrors: this.listenerErrors,
      };
    }
  }
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A truncated or hand-edited row must not make the whole log unreadable.
    return raw;
  }
}
