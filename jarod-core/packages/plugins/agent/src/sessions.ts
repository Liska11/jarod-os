// Portage de packages/core/src/services/sessions.ts (rév. 2e180305).
import { type Db, ftsQuery } from "@jarod/plugin-storage";
import type { Attachment, Message, Role, SearchHit, Session, SessionContext, ToolCall } from "@jarod/contracts";
import { newId, now, parseJson } from "@jarod/kernel/util";

interface SessionRow {
  id: string;
  title: string;
  pinned: number;
  created_at: number;
  updated_at: number;
  message_count: number;
  workspace: string | null;
  provider: string | null;
  model: string | null;
  agent_mode: string | null;
  model_pinned: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: Role;
  content: string;
  thinking: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: number;
  provider: string | null;
  model: string | null;
  raw: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  attachments: string | null;
  kind: string | null;
  compacted: number;
  seq: number;
  created_at: number;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  title: r.title,
  pinned: r.pinned === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  messageCount: r.message_count,
  ...(r.provider
    ? {
        context: {
          workspace: r.workspace,
          provider: r.provider,
          model: r.model ?? "",
          agentMode: r.agent_mode === "plan" ? "plan" : "build",
          ...(r.model_pinned ? { modelPinned: true } : {}),
        },
      }
    : {}),
});

/** Attachment ids referenced by message rows. */
const attachmentIdsOf = (rows: { attachments: string | null }[]): string[] =>
  rows.flatMap((r) => (r.attachments ? parseJson<Attachment[]>(r.attachments, []).map((a) => a.id) : []));

const toMessage = (r: MessageRow): Message => {
  const m: Message = { id: r.id, sessionId: r.session_id, role: r.role, content: r.content, createdAt: r.created_at };
  if (r.thinking) m.thinking = r.thinking;
  if (r.tool_calls) m.toolCalls = parseJson<ToolCall[]>(r.tool_calls, []);
  if (r.tool_call_id) m.toolCallId = r.tool_call_id;
  if (r.tool_name) m.toolName = r.tool_name;
  if (r.is_error) m.isError = true;
  if (r.provider) m.provider = r.provider;
  if (r.model) m.model = r.model;
  if (r.raw) m.raw = parseJson<unknown>(r.raw, undefined);
  if (r.input_tokens != null) m.inputTokens = r.input_tokens;
  if (r.output_tokens != null) m.outputTokens = r.output_tokens;
  if (r.cache_read_tokens) m.cacheReadTokens = r.cache_read_tokens;
  if (r.cache_write_tokens) m.cacheWriteTokens = r.cache_write_tokens;
  if (r.attachments) m.attachments = parseJson<Attachment[]>(r.attachments, []);
  if (r.kind === "summary") m.kind = "summary";
  if (r.compacted) m.compacted = true;
  return m;
};

const SESSION_SELECT = `
  SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
  FROM sessions s`;

export type NewMessage = Omit<Message, "id" | "createdAt" | "sessionId" | "compacted">;

export class SessionService {
  /** Called with the attachments of deleted messages (the owner removes files nothing else uses). */
  onAttachmentsRemoved: (ids: string[]) => void = () => {};
  /** Called once a conversation is gone, so what shadows it (the event log) goes with it. */
  onDeleted: (id: string) => void = () => {};

  constructor(private readonly db: Db) {}

  create(title = "Nouvelle conversation"): Session {
    const id = newId();
    const t = now();
    this.db.run("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", id, title, t, t);
    return this.get(id)!;
  }

  get(id: string): Session | undefined {
    const row = this.db.get<SessionRow>(`${SESSION_SELECT} WHERE s.id = ?`, id);
    return row && toSession(row);
  }

  list(limit = 200): Session[] {
    return this.db
      .all<SessionRow>(`${SESSION_SELECT} ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?`, limit)
      .map(toSession);
  }

  rename(id: string, title: string): void {
    this.db.run("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", title.trim() || "Sans titre", now(), id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.run("UPDATE sessions SET pinned = ? WHERE id = ?", pinned ? 1 : 0, id);
  }

  delete(id: string): void {
    const removed = attachmentIdsOf(
      this.db.all<{ attachments: string | null }>(
        "SELECT attachments FROM messages WHERE session_id = ? AND attachments IS NOT NULL",
        id,
      ),
    );
    this.db.run("DELETE FROM sessions WHERE id = ?", id);
    if (removed.length) this.onAttachmentsRemoved(removed);
    this.onDeleted(id);
  }

  /**
   * Pins the workspace, model and mode a conversation runs with. Jarod-cordis (Q10) : `modelPinned` absent =
   * épingle du modèle inchangée ; `true`/`false` l'écrit.
   */
  setContext(id: string, ctx: SessionContext): void {
    this.db.run(
      "UPDATE sessions SET workspace = ?, provider = ?, model = ?, agent_mode = ?, model_pinned = COALESCE(?, model_pinned) WHERE id = ?",
      ctx.workspace,
      ctx.provider,
      ctx.model,
      ctx.agentMode,
      ctx.modelPinned === undefined ? null : ctx.modelPinned ? 1 : 0,
      id,
    );
  }

  touch(id: string): void {
    this.db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", now(), id);
  }

  /** Full-text search over message bodies (FTS5) plus a title match. */
  search(text: string, limit = 50): SearchHit[] {
    const q = ftsQuery(text);
    if (!q) return [];
    const like = `%${text.trim()}%`;
    const hits = this.db.all<{ session_id: string; title: string; snippet: string; updated_at: number }>(
      `SELECT m.session_id, s.title, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet, s.updated_at
       FROM messages_fts
       JOIN messages m ON m.seq = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      q,
      limit * 3,
    );
    const titleHits = this.db.all<{ id: string; title: string; updated_at: number }>(
      "SELECT id, title, updated_at FROM sessions WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?",
      like,
      limit,
    );
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const t of titleHits) {
      seen.add(t.id);
      out.push({ sessionId: t.id, title: t.title, snippet: "", updatedAt: t.updated_at });
    }
    for (const h of hits) {
      if (seen.has(h.session_id)) continue;
      seen.add(h.session_id);
      out.push({ sessionId: h.session_id, title: h.title, snippet: h.snippet, updatedAt: h.updated_at });
    }
    return out.slice(0, limit);
  }
}

export class MessageService {
  /** Called with the attachments of deleted messages (the owner removes files nothing else uses). */
  onAttachmentsRemoved: (ids: string[]) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
  ) {}

  add(sessionId: string, msg: NewMessage): Message {
    const id = newId();
    const t = now();
    this.db.run(
      `INSERT INTO messages (id, session_id, role, content, thinking, tool_calls, tool_call_id, tool_name, is_error,
         provider, model, raw, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, attachments, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      msg.role,
      msg.content,
      msg.thinking ?? null,
      msg.toolCalls?.length ? JSON.stringify(msg.toolCalls) : null,
      msg.toolCallId ?? null,
      msg.toolName ?? null,
      msg.isError ? 1 : 0,
      msg.provider ?? null,
      msg.model ?? null,
      msg.raw === undefined ? null : JSON.stringify(msg.raw),
      msg.inputTokens ?? null,
      msg.outputTokens ?? null,
      msg.cacheReadTokens ?? null,
      msg.cacheWriteTokens ?? null,
      msg.attachments?.length ? JSON.stringify(msg.attachments) : null,
      msg.kind ?? null,
      t,
    );
    this.sessions.touch(sessionId);
    return this.get(id)!;
  }

  get(id: string): Message | undefined {
    const row = this.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
    return row && toMessage(row);
  }

  list(sessionId: string): Message[] {
    return this.db
      .all<MessageRow>("SELECT * FROM messages WHERE session_id = ? ORDER BY seq", sessionId)
      .map(toMessage);
  }

  /**
   * What the model sees: the latest compaction summary (if any) followed by every message
   * that has not been compacted away.
   */
  history(sessionId: string): Message[] {
    const rows = this.db.all<MessageRow>(
      "SELECT * FROM messages WHERE session_id = ? AND compacted = 0 ORDER BY seq",
      sessionId,
    );
    const summaries = rows.filter((r) => r.kind === "summary");
    const latest = summaries.at(-1);
    const rest = rows.filter((r) => r.kind !== "summary");
    return [...(latest ? [latest] : []), ...rest].map(toMessage);
  }

  /**
   * Replaces every message before `keepFromId` with a summary. Older messages stay in the
   * database (and in the UI) but are no longer sent to the model.
   */
  compact(sessionId: string, keepFromId: string, summary: string): Message {
    return this.db.tx(() => {
      const keep = this.db.get<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", keepFromId);
      if (!keep) throw new Error("Message introuvable");
      this.db.run(
        "UPDATE messages SET compacted = 1 WHERE session_id = ? AND (seq < ? OR kind = 'summary')",
        sessionId,
        keep.seq,
      );
      return this.add(sessionId, { role: "user", kind: "summary", content: summary });
    });
  }

  /** Deletes messages from `fromSeq` on and reports the attachments they carried (except `keep`). */
  private deleteFromSeq(sessionId: string, fromSeq: number, keep: string[] = []): void {
    const removed = attachmentIdsOf(
      this.db.all<{ attachments: string | null }>(
        "SELECT attachments FROM messages WHERE session_id = ? AND seq >= ? AND attachments IS NOT NULL",
        sessionId,
        fromSeq,
      ),
    ).filter((id) => !keep.includes(id));
    this.db.run("DELETE FROM messages WHERE session_id = ? AND seq >= ?", sessionId, fromSeq);
    if (removed.length) this.onAttachmentsRemoved(removed);
  }

  clear(sessionId: string): void {
    this.deleteFromSeq(sessionId, 0);
  }

  /** Deletes every message after the last user message (keeps it). Returns that user message. */
  truncateAfterLastUser(sessionId: string): Message | undefined {
    const last = this.db.get<{ seq: number; id: string }>(
      "SELECT seq, id FROM messages WHERE session_id = ? AND role = 'user' AND kind IS NULL ORDER BY seq DESC LIMIT 1",
      sessionId,
    );
    if (!last) return undefined;
    this.db.run("DELETE FROM messages WHERE session_id = ? AND seq > ?", sessionId, last.seq);
    return this.get(last.id);
  }

  /** Deletes the last user message and everything after it. Returns the removed user text. */
  undoLastTurn(sessionId: string): string | undefined {
    const last = this.db.get<{ seq: number; content: string }>(
      "SELECT seq, content FROM messages WHERE session_id = ? AND role = 'user' AND kind IS NULL ORDER BY seq DESC LIMIT 1",
      sessionId,
    );
    if (!last) return undefined;
    this.deleteFromSeq(sessionId, last.seq);
    return last.content;
  }

  /**
   * Deletes a message and everything after it (edit & resend). Returns the deleted message; its
   * own attachments are kept, since the edited message is sent again with them.
   */
  deleteFrom(sessionId: string, messageId: string): Message | undefined {
    const target = this.db.get<MessageRow>(
      "SELECT * FROM messages WHERE id = ? AND session_id = ?",
      messageId,
      sessionId,
    );
    if (!target) return undefined;
    this.deleteFromSeq(sessionId, target.seq, attachmentIdsOf([target]));
    return toMessage(target);
  }

  /** Copies messages up to and including `uptoId` into another session (conversation fork). */
  copyTo(fromSessionId: string, toSessionId: string, uptoId: string): number {
    const upto = this.db.get<{ seq: number }>(
      "SELECT seq FROM messages WHERE id = ? AND session_id = ?",
      uptoId,
      fromSessionId,
    );
    if (!upto) throw new Error("Message introuvable");
    const rows = this.db.all<MessageRow>(
      "SELECT * FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq",
      fromSessionId,
      upto.seq,
    );
    // A fork must not end on an assistant message whose tool calls have no results yet.
    const last = rows.at(-1);
    if (last?.role === "assistant" && last.tool_calls) rows.pop();
    this.db.tx(() => {
      for (const r of rows) {
        this.db.run(
          `INSERT INTO messages (id, session_id, role, content, thinking, tool_calls, tool_call_id, tool_name, is_error,
             provider, model, raw, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, attachments, kind, compacted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(),
          toSessionId,
          r.role,
          r.content,
          r.thinking,
          r.tool_calls,
          r.tool_call_id,
          r.tool_name,
          r.is_error,
          r.provider,
          r.model,
          r.raw,
          r.input_tokens,
          r.output_tokens,
          r.cache_read_tokens,
          r.cache_write_tokens,
          r.attachments,
          r.kind,
          r.compacted,
          r.created_at,
        );
      }
    });
    this.sessions.touch(toSessionId);
    return rows.length;
  }

  usageForSession(sessionId: string): { inputTokens: number; outputTokens: number } {
    const r = this.db.get<{ i: number | null; o: number | null }>(
      "SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM messages WHERE session_id = ?",
      sessionId,
    );
    return { inputTokens: r?.i ?? 0, outputTokens: r?.o ?? 0 };
  }

  /** Token totals grouped by day and model, for the usage dashboard. */
  usageByDay(days = 30): {
    day: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    messages: number;
  }[] {
    const since = now() - days * 86_400_000;
    return this.db.all(
      `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, provider, model,
              SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens, COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
              COUNT(*) AS messages
       FROM messages
       WHERE role = 'assistant' AND created_at >= ? AND model IS NOT NULL
       GROUP BY day, provider, model
       ORDER BY day DESC`,
      since,
    );
  }
}
