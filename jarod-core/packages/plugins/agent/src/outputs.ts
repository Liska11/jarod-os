/**
 * Cockpit, lot 3 (context-mode, natif) : les sorties d'outils VOLUMINEUSES restent hors du contexte.
 *
 * Au-delà de `OUTPUT_THRESHOLD` caractères, la sortie entière est gardée dans la base (table `tool_outputs`, chiffrée quand la base l'est)
 * et découpée en fenêtres de lignes indexées plein texte. Le modèle reçoit un contrat court :
 *  - un résumé (début, fin, taille, nombre de lignes) ;
 *  - une RÉFÉRENCE (`out:<id>`) et la provenance (outil, empreinte SHA-256) ;
 *  - deux outils : `output_search` (extraits exacts, numéros de ligne) et `output_read` (lignes exactes de l'original).
 *
 * Rien n'est jeté : l'original reste relisible tant que la conversation existe (une preuve nécessaire au diagnostic n'est jamais
 * supprimée par la compression). Les économies de contexte sont comptées par conversation.
 *
 * Coordination (lot 4) : ce module est la SEULE autorité sur les sorties d'outils ; la compression de l'historique (billion-context)
 * ne recompresse jamais un aperçu déjà produit ici (il porte sa référence).
 */
import { createHash, randomUUID } from "node:crypto";
import { type Db, ftsQuery } from "@jarod/plugin-storage";

export const OUTPUT_THRESHOLD = 8000;
const CHUNK_LINES = 20;
const READ_MAX_LINES = 400;
const READ_MAX_CHARS = 12_000;
/** Ces sorties entrent toujours entières : des instructions (skills) ou des lectures déjà bornées de ce module. */
export const OUTPUT_EXEMPT: ReadonlySet<string> = new Set(["load_skill", "read_skill_file", "output_search", "output_read", "task_status"]);

export interface StoredOutput {
  id: string;
  sessionId: string;
  tool: string;
  bytes: number;
  lines: number;
  sha256: string;
  createdAt: number;
}

export interface OutputStats {
  outputs: number;
  storedChars: number;
  previewChars: number;
  /** Caractères gardés hors du contexte. */
  savedChars: number;
}

export class OutputStore {
  constructor(
    private readonly db: Db,
    private readonly o: { threshold?: number; now?: () => number } = {},
  ) {}

  get threshold(): number {
    return this.o.threshold ?? OUTPUT_THRESHOLD;
  }

  /** Le texte à mettre dans la conversation : la sortie telle quelle si elle est courte, sinon l'aperçu et sa référence. */
  keep(sessionId: string, tool: string, text: string): { content: string; stored?: StoredOutput } {
    if (text.length <= this.threshold || OUTPUT_EXEMPT.has(tool)) return { content: text };
    const lines = text.split(/\r?\n/);
    const id = randomUUID().slice(0, 12);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const at = this.o.now?.() ?? Date.now();
    const head = lines.slice(0, 40).join("\n").slice(0, 2500);
    const tail = lines.length > 60 ? lines.slice(-15).join("\n").slice(-1200) : "";
    const preview =
      `[Sortie volumineuse gardée hors du contexte — référence out:${id} · outil ${tool} · ${text.length} caractères · ${lines.length} lignes · sha256 ${sha256.slice(0, 16)}]\n` +
      `${head}\n` +
      (tail ? `… [lignes ${41} à ${lines.length - 15} non montrées]\n${tail}\n` : "") +
      `[Pour la suite : output_search (query, id="${id}") rend les extraits exacts avec leurs numéros de ligne ; output_read (id="${id}", from, to) rend les lignes de l'original.]`;
    this.db.tx(() => {
      this.db.run(
        "INSERT INTO tool_outputs (id, session_id, tool, bytes, lines, sha256, preview_chars, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        sessionId,
        tool,
        text.length,
        lines.length,
        sha256,
        preview.length,
        text,
        at,
      );
      for (let i = 0; i < lines.length; i += CHUNK_LINES) {
        const chunk = lines.slice(i, i + CHUNK_LINES).join("\n");
        if (chunk.trim()) this.db.run("INSERT INTO tool_output_chunks (output_id, line_start, line_end, text) VALUES (?, ?, ?, ?)", id, i + 1, Math.min(i + CHUNK_LINES, lines.length), chunk);
      }
    });
    return { content: preview, stored: { id, sessionId, tool, bytes: text.length, lines: lines.length, sha256, createdAt: at } };
  }

  /** Les extraits qui répondent à la requête, dans les sorties de la conversation (ou d'une seule), meilleurs d'abord. */
  search(sessionId: string, query: string, o: { id?: string; limit?: number } = {}): { id: string; tool: string; lineStart: number; lineEnd: number; lines: string[] }[] {
    const q = ftsQuery(query, "or");
    if (!q) return [];
    const words = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1);
    const rows = this.db.all<{ output_id: string; tool: string; line_start: number; line_end: number; text: string }>(
      `SELECT c.output_id, o.tool, c.line_start, c.line_end, c.text
         FROM tool_output_chunks_fts f JOIN tool_output_chunks c ON c.id = f.rowid JOIN tool_outputs o ON o.id = c.output_id
        WHERE tool_output_chunks_fts MATCH ? AND o.session_id = ? ${o.id ? "AND o.id = ?" : ""}
        ORDER BY bm25(tool_output_chunks_fts) LIMIT ?`,
      ...(o.id ? [q, sessionId, o.id, o.limit ?? 5] : [q, sessionId, o.limit ?? 5]),
    );
    // Dans chaque fenêtre, seules les lignes qui portent un mot cherché (et leurs voisines) : des extraits, pas des pages.
    return rows.map((r) => {
      const all = r.text.split("\n");
      const keep = new Set<number>();
      all.forEach((l, i) => {
        const low = l.toLowerCase();
        if (words.some((w) => low.includes(w))) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < all.length) keep.add(j);
      });
      const idx = keep.size ? [...keep].sort((a, b) => a - b) : all.map((_l, i) => i).slice(0, 5);
      return { id: r.output_id, tool: r.tool, lineStart: r.line_start, lineEnd: r.line_end, lines: idx.map((i) => `${r.line_start + i}: ${all[i]}`) };
    });
  }

  /** Les lignes exactes `from`..`to` (1-indexées, incluses) de l'original, bornées. */
  read(sessionId: string, id: string, from = 1, to?: number): { text: string; from: number; to: number; total: number } | null {
    const row = this.db.get<{ text: string; lines: number }>("SELECT text, lines FROM tool_outputs WHERE id = ? AND session_id = ?", id, sessionId);
    if (!row) return null;
    const lines = row.text.split(/\r?\n/);
    const start = Math.max(1, Math.floor(from));
    let end = Math.min(lines.length, Math.floor(to ?? start + READ_MAX_LINES - 1), start + READ_MAX_LINES - 1);
    // Coupé à une ligne ENTIÈRE : la suite reprend exactement où celle-ci s'arrête (une ligne seule trop longue sort entière).
    const out: string[] = [];
    let size = 0;
    for (let n = start; n <= end; n++) {
      const l = `${n}: ${lines[n - 1]}`;
      if (out.length && size + l.length + 1 > READ_MAX_CHARS) break;
      out.push(l);
      size += l.length + 1;
    }
    end = start + out.length - 1;
    return { text: out.join("\n"), from: start, to: end, total: lines.length };
  }

  list(sessionId: string): StoredOutput[] {
    return this.db
      .all<{ id: string; session_id: string; tool: string; bytes: number; lines: number; sha256: string; created_at: number }>(
        "SELECT id, session_id, tool, bytes, lines, sha256, created_at FROM tool_outputs WHERE session_id = ? ORDER BY created_at DESC",
        sessionId,
      )
      .map((r) => ({ id: r.id, sessionId: r.session_id, tool: r.tool, bytes: r.bytes, lines: r.lines, sha256: r.sha256, createdAt: r.created_at }));
  }

  stats(sessionId?: string): OutputStats {
    const r = this.db.get<{ n: number; s: number | null; p: number | null }>(
      `SELECT COUNT(*) AS n, SUM(bytes) AS s, SUM(preview_chars) AS p FROM tool_outputs ${sessionId ? "WHERE session_id = ?" : ""}`,
      ...(sessionId ? [sessionId] : []),
    );
    const stored = r?.s ?? 0;
    const preview = r?.p ?? 0;
    return { outputs: r?.n ?? 0, storedChars: stored, previewChars: preview, savedChars: Math.max(0, stored - preview) };
  }

  /** Avec la conversation : ses sorties ne lui survivent pas. */
  forget(sessionId: string): void {
    this.db.run("DELETE FROM tool_outputs WHERE session_id = ?", sessionId);
  }
}

/** Les outils de l'agent sur ce magasin : lecture seule, limités à la conversation en cours. */
export function outputTools(store: OutputStore) {
  return [
    {
      name: "output_search",
      description:
        "Cherche dans les sorties volumineuses gardées hors du contexte (référence out:<id>) de cette conversation ; rend les extraits exacts avec leurs numéros de ligne.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, id: { type: "string", description: "Limiter à une sortie (l'id après out:)." } },
        required: ["query"],
      },
      source: "builtin" as const,
      async run(args: Record<string, unknown>, ctx: { sessionId: string }) {
        const hits = store.search(ctx.sessionId, String(args.query ?? ""), typeof args.id === "string" && args.id ? { id: args.id.replace(/^out:/, "") } : {});
        if (!hits.length) return "Aucun extrait ne correspond.";
        return hits.map((h) => `out:${h.id} (${h.tool}), lignes ${h.lineStart}-${h.lineEnd} :\n${h.lines.join("\n")}`).join("\n\n");
      },
    },
    {
      name: "output_read",
      description: "Relit les lignes exactes d'une sortie gardée hors du contexte (référence out:<id>) : from et to, 1-indexés ; 400 lignes au plus par appel.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } },
        required: ["id"],
      },
      source: "builtin" as const,
      async run(args: Record<string, unknown>, ctx: { sessionId: string }) {
        const id = String(args.id ?? "").replace(/^out:/, "");
        const r = store.read(ctx.sessionId, id, typeof args.from === "number" ? args.from : 1, typeof args.to === "number" ? args.to : undefined);
        if (!r) return `Sortie inconnue dans cette conversation : out:${id}`;
        return `out:${id}, lignes ${r.from}-${r.to} sur ${r.total} :\n${r.text}`;
      },
    },
  ];
}
