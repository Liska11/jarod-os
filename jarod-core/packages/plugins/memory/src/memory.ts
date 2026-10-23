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

/** V-18 : une ligne de l'historique de la mémoire. `before`/`after` absents pour un ajout / un retrait. */
export interface MemoryChange {
  seq: number;
  memoryId: string;
  action: "add" | "update" | "delete";
  before?: { type: string; content: string };
  after?: { type: string; content: string };
  at: number;
}

interface HistoryRow {
  seq: number;
  memory_id: string;
  action: MemoryChange["action"];
  type_before: string | null;
  type_after: string | null;
  content_before: string | null;
  content_after: string | null;
  at: number;
}

const toChange = (r: HistoryRow): MemoryChange => ({
  seq: r.seq,
  memoryId: r.memory_id,
  action: r.action,
  ...(r.content_before !== null ? { before: { type: r.type_before ?? "fact", content: r.content_before } } : {}),
  ...(r.content_after !== null ? { after: { type: r.type_after ?? "fact", content: r.content_after } } : {}),
  at: r.at,
});

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

  /**
   * V-18 : les changements de la mémoire, du plus récent au plus ancien (écrits par les déclencheurs de `memory_history`, quel que
   * soit l'écrivain). `memoryId` limite à un souvenir.
   */
  history(opts: { memoryId?: string; limit?: number } = {}): MemoryChange[] {
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const rows = opts.memoryId
      ? this.db.all<HistoryRow>("SELECT * FROM memory_history WHERE memory_id = ? ORDER BY seq DESC LIMIT ?", opts.memoryId, limit)
      : this.db.all<HistoryRow>("SELECT * FROM memory_history ORDER BY seq DESC LIMIT ?", limit);
    return rows.map(toChange);
  }

  /**
   * V-18 : défait un changement de l'historique. Un ajout → le souvenir est retiré ; une modification → le texte et le type d'avant
   * reviennent ; un retrait → le souvenir revient avec son identifiant d'origine. Refusé (sans rien écrire) quand l'état actuel ne
   * permet pas de défaire proprement : souvenir déjà retiré, déjà présent, ou un texte identique existe déjà ailleurs. Le geste laisse
   * lui-même sa ligne d'historique (on peut donc défaire un rétablissement).
   */
  restore(seq: number): { memoryId: string; did: "removed" | "reverted" | "recreated" } {
    const row = Number.isSafeInteger(seq) ? this.db.get<HistoryRow>("SELECT * FROM memory_history WHERE seq = ?", seq) : undefined;
    if (!row) throw new Error("Changement inconnu dans l'historique de la mémoire.");
    const current = this.get(row.memory_id);
    if (row.action === "add") {
      if (!current) throw new Error("Ce souvenir n'existe plus : rien à défaire.");
      this.delete(row.memory_id);
      return { memoryId: row.memory_id, did: "removed" };
    }
    const content = row.content_before ?? "";
    const type = (MEMORY_TYPES as string[]).includes(row.type_before ?? "") ? (row.type_before as MemoryType) : "fact";
    if (!content.trim()) throw new Error("Ce changement n'a pas de texte d'avant à rétablir.");
    const twin = this.db.get<Row>("SELECT * FROM memories WHERE content = ? AND id != ?", content, row.memory_id);
    if (twin) throw new Error("Un souvenir identique existe déjà : rien n'est rétabli en double.");
    if (row.action === "update") {
      if (!current) throw new Error("Ce souvenir a été retiré depuis : rétablissez d'abord son retrait.");
      this.update(row.memory_id, content, type);
      return { memoryId: row.memory_id, did: "reverted" };
    }
    if (current) throw new Error("Ce souvenir est déjà présent.");
    const t = now();
    this.db.run("INSERT INTO memories (id, type, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", row.memory_id, type, content, t, t);
    return { memoryId: row.memory_id, did: "recreated" };
  }

  /** V-18 : efface l'historique (d'un souvenir, ou tout) ; rend le nombre de lignes effacées. Irréversible. */
  purgeHistory(memoryId?: string): number {
    const before = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM memory_history" + (memoryId ? " WHERE memory_id = ?" : ""), ...(memoryId ? [memoryId] : []))?.n ?? 0;
    if (memoryId) this.db.run("DELETE FROM memory_history WHERE memory_id = ?", memoryId);
    else this.db.run("DELETE FROM memory_history");
    return before;
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
