// Portage de packages/core/src/services/memory.ts (rév. 2e180305).
import { type Db, ftsQuery } from "@jarod/plugin-storage";
import type { Memory, MemoryType } from "@jarod/contracts";
import { newId, now } from "@jarod/kernel/util";

interface Row {
  id: string;
  type: MemoryType;
  content: string;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  type: r.type,
  content: r.content,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const MEMORY_TYPES: MemoryType[] = ["fact", "preference", "context", "conversation"];

/** Long-term memory: durable facts and preferences the agent recalls across conversations. */
export class MemoryService {
  constructor(private readonly db: Db) {}

  add(content: string, type: MemoryType = "fact"): Memory {
    const text = content.trim();
    if (!text) throw new Error("Mémoire vide");
    if (!MEMORY_TYPES.includes(type)) type = "fact";
    const existing = this.db.get<Row>("SELECT * FROM memories WHERE content = ?", text);
    if (existing) return toMemory(existing);
    const id = newId();
    const t = now();
    this.db.run(
      "INSERT INTO memories (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      id,
      type,
      text,
      t,
      t,
    );
    return this.get(id)!;
  }

  get(id: string): Memory | undefined {
    const r = this.db.get<Row>("SELECT * FROM memories WHERE id = ?", id);
    return r && toMemory(r);
  }

  list(type?: MemoryType): Memory[] {
    const rows = type
      ? this.db.all<Row>("SELECT * FROM memories WHERE type = ? ORDER BY updated_at DESC", type)
      : this.db.all<Row>("SELECT * FROM memories ORDER BY updated_at DESC");
    return rows.map(toMemory);
  }

  update(id: string, content: string, type?: MemoryType): void {
    this.db.run(
      "UPDATE memories SET content = ?, type = COALESCE(?, type), updated_at = ? WHERE id = ?",
      content.trim(),
      type ?? null,
      now(),
      id,
    );
  }

  delete(id: string): void {
    this.db.run("DELETE FROM memories WHERE id = ?", id);
  }

  search(text: string, limit = 20): Memory[] {
    const q = ftsQuery(text, "or");
    if (!q) return [];
    return this.db
      .all<Row>(
        `SELECT m.* FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
         WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
        q,
        limit,
      )
      .map(toMemory);
  }

  /**
   * Memories to inject into the system prompt: every preference (they apply everywhere),
   * plus the facts most relevant to the current request.
   */
  relevant(query: string, limit = 12): Memory[] {
    const prefs = this.list("preference").slice(0, 8);
    const matches = this.search(query, limit);
    const recent = matches.length > 0 ? [] : this.list().slice(0, 5);
    const byId = new Map<string, Memory>();
    for (const m of [...prefs, ...matches, ...recent]) byId.set(m.id, m);
    return [...byId.values()].slice(0, limit + prefs.length);
  }
}
