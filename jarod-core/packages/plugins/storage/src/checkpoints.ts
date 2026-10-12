import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "./db.js";
import { now } from "@jarod/kernel/util";

/** Files larger than this are not snapshotted (the change can then not be undone). */
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export interface RewindResult {
  restored: string[];
  deleted: string[];
}

/**
 * Remembers what a file contained before the agent first changed it in a turn (a turn starts
 * with a user message), so that `/rewind` can put the files back. Changes made through
 * run_shell are not tracked.
 */
export class CheckpointService {
  constructor(private readonly db: Db) {}

  private currentTurn(sessionId: string): number {
    const row = this.db.get<{ seq: number }>(
      "SELECT seq FROM messages WHERE session_id = ? AND role = 'user' AND kind IS NULL ORDER BY seq DESC LIMIT 1",
      sessionId,
    );
    return row?.seq ?? 0;
  }

  /** Call before writing `path`: keeps its current content (or its absence) once per turn. */
  capture(sessionId: string, path: string): void {
    const turn = this.currentTurn(sessionId);
    if (
      this.db.get(
        "SELECT 1 AS x FROM file_checkpoints WHERE session_id = ? AND turn = ? AND path = ?",
        sessionId,
        turn,
        path,
      )
    )
      return;
    let content: Buffer | null = null;
    if (existsSync(path)) {
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return;
      content = readFileSync(path);
    }
    this.db.run(
      "INSERT INTO file_checkpoints (session_id, turn, path, content, created_at) VALUES (?, ?, ?, ?, ?)",
      sessionId,
      turn,
      path,
      content,
      now(),
    );
  }

  /** Files the agent changed in the most recent turn that changed any, with their turn. */
  latest(sessionId: string): { turn: number; paths: string[] } | null {
    const top = this.db.get<{ turn: number }>(
      "SELECT MAX(turn) AS turn FROM file_checkpoints WHERE session_id = ?",
      sessionId,
    );
    if (top?.turn == null) return null;
    const paths = this.db
      .all<{ path: string }>(
        "SELECT path FROM file_checkpoints WHERE session_id = ? AND turn = ? ORDER BY seq",
        sessionId,
        top.turn,
      )
      .map((r) => r.path);
    return { turn: top.turn, paths };
  }

  /** Puts back the files changed in the most recent turn; a second call goes one turn further back. */
  rewind(sessionId: string): RewindResult | null {
    const latest = this.latest(sessionId);
    if (!latest) return null;
    const rows = this.db.all<{ path: string; content: Buffer | null }>(
      "SELECT path, content FROM file_checkpoints WHERE session_id = ? AND turn = ? ORDER BY seq",
      sessionId,
      latest.turn,
    );
    const result: RewindResult = { restored: [], deleted: [] };
    for (const r of rows) {
      if (r.content === null) {
        rmSync(r.path, { force: true });
        result.deleted.push(r.path);
      } else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, r.content);
        result.restored.push(r.path);
      }
    }
    this.db.run("DELETE FROM file_checkpoints WHERE session_id = ? AND turn = ?", sessionId, latest.turn);
    return result;
  }
}
