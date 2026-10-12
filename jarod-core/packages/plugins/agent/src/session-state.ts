/**
 * Jarod-cordis (Q18, décision utilisateur 2026-09-28) : état de travail par conversation — portage de
 * SANK-AI `src/core/runtime/kernel/session-state.js` (MIT © SankAi contributors), pattern RLM « l'état
 * appartient à la SESSION, pas au tour ». Écarts : persistant (table `session_state`, migration v18) au
 * lieu d'une `Map` en mémoire ; plafonds (clés, taille) ; la copie isolée de l'enfant (fork-on-spawn)
 * devient une lecture seule — un sous-agent lit l'état du parent, il ne l'écrit pas.
 */
import type { Db } from "@jarod/plugin-storage";
import type { ToolDef } from "@jarod/plugin-tools";

export type StateType = "text" | "json";
export interface StateEntry {
  key: string;
  type: StateType;
  value: unknown;
  updatedAt: number;
}

export const STATE_MAX_KEYS = 64;
export const STATE_MAX_VALUE_BYTES = 8 * 1024;
export const STATE_MAX_KEY_CHARS = 100;
/** Longueur d'une valeur dans le résumé du prompt (celle de SANK-AI `summary`). */
const SUMMARY_VALUE_CHARS = 200;

export class SessionStateService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  set(sessionId: string, key: string, value: unknown, type: StateType = "text"): void {
    const k = key.trim();
    if (!k || k.length > STATE_MAX_KEY_CHARS) throw new Error(`Clé invalide (1 à ${STATE_MAX_KEY_CHARS} caractères).`);
    if (value === undefined) throw new Error("Valeur absente.");
    // JSON seulement : l'état doit survivre à la base (contrainte RLM de SANK-AI, `set`).
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      throw new Error(`Valeur non sérialisable pour ${k}.`);
    }
    if (Buffer.byteLength(json, "utf8") > STATE_MAX_VALUE_BYTES) {
      throw new Error(`Valeur trop grande pour ${k} (plus de ${STATE_MAX_VALUE_BYTES / 1024} Ko) : rangez-la dans un fichier.`);
    }
    this.db.tx(() => {
      const exists = this.db.get("SELECT 1 FROM session_state WHERE session_id = ? AND key = ?", sessionId, k);
      if (!exists) {
        const n = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_state WHERE session_id = ?", sessionId)!.n;
        if (n >= STATE_MAX_KEYS) throw new Error(`État plein (${STATE_MAX_KEYS} clés) : supprimez-en avec state_delete.`);
      }
      this.db.run(
        `INSERT INTO session_state (session_id, key, type, value, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, key) DO UPDATE SET type = excluded.type, value = excluded.value, updated_at = excluded.updated_at`,
        sessionId,
        k,
        type,
        json,
        this.now(),
      );
    });
  }

  get(sessionId: string, key: string): unknown {
    const row = this.db.get<{ value: string }>("SELECT value FROM session_state WHERE session_id = ? AND key = ?", sessionId, key.trim());
    return row ? JSON.parse(row.value) : undefined;
  }

  delete(sessionId: string, key: string): boolean {
    return this.db.run("DELETE FROM session_state WHERE session_id = ? AND key = ?", sessionId, key.trim()).changes > 0;
  }

  list(sessionId: string): StateEntry[] {
    return this.db
      .all<{ key: string; type: StateType; value: string; updated_at: number }>(
        "SELECT key, type, value, updated_at FROM session_state WHERE session_id = ? ORDER BY key",
        sessionId,
      )
      .map((r) => ({ key: r.key, type: r.type, value: JSON.parse(r.value), updatedAt: r.updated_at }));
  }

  /** Bloc ajouté au prompt système : il survit à la compaction (SANK-AI `summary`). Vide = rien. */
  summary(sessionId: string): string {
    const items = this.list(sessionId);
    if (!items.length) return "";
    const lines = items.map((i) => {
      const v = typeof i.value === "string" ? i.value : JSON.stringify(i.value);
      return `- ${i.key} (${i.type}): ${v.length > SUMMARY_VALUE_CHARS ? `${v.slice(0, SUMMARY_VALUE_CHARS)}…` : v}`;
    });
    return `# État de travail de la conversation (survit à la compaction ; outils state_*)\n${lines.join("\n")}`;
  }
}

/** Les outils `state_*` (schémas de SANK-AI, descriptions en français). Écriture exclue des sous-agents. */
export function sessionStateTools(state: SessionStateService): ToolDef[] {
  const keyOf = (args: Record<string, unknown>) => String(args.key ?? "");
  return [
    {
      name: "state_set",
      description:
        "Stocke une valeur de travail persistante (texte ou JSON) pour CETTE conversation : elle survit aux tours et à la compaction du contexte. Pour les variables de travail (chemins, identifiants, étapes), pas pour des souvenirs durables.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Nom de la variable de travail" },
          value: { type: ["string", "object", "number", "boolean", "array"], description: "Valeur (sérialisable en JSON)" },
          type: { type: "string", enum: ["text", "json"], description: "text|json (défaut : text)" },
        },
        required: ["key", "value"],
      },
      source: "builtin",
      async run(args, ctx) {
        state.set(ctx.sessionId, keyOf(args), args.value, args.type === "json" ? "json" : "text");
        return `ok : state[${keyOf(args).trim()}] enregistré`;
      },
    },
    {
      name: "state_get",
      description: "Lit une valeur de l'état de travail de la conversation.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      source: "builtin",
      async run(args, ctx) {
        const v = state.get(ctx.sessionId, keyOf(args));
        return v === undefined ? `Aucune valeur pour ${keyOf(args)}.` : JSON.stringify(v);
      },
    },
    {
      name: "state_list",
      description: "Liste les variables de l'état de travail de la conversation.",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      async run(_args, ctx) {
        return JSON.stringify(state.list(ctx.sessionId).map(({ key, type, value }) => ({ key, type, value })));
      },
    },
    {
      name: "state_delete",
      description: "Supprime une variable de l'état de travail de la conversation.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      source: "builtin",
      async run(args, ctx) {
        return state.delete(ctx.sessionId, keyOf(args)) ? `ok : ${keyOf(args)} supprimé` : `Aucune valeur pour ${keyOf(args)}.`;
      },
    },
  ];
}
