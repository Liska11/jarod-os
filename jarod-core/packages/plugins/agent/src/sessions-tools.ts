// Portage de packages/core/src/tools/sessions.ts (rév. 2e180305).
import { transcript } from "./agent.js";
import type { MessageService, SessionService } from "./sessions.js";
import type { ToolDef } from "@jarod/plugin-tools";

const DEFAULT_READ_CHARS = 8000;
const MAX_READ_CHARS = 30_000;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const clamp = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback;

/**
 * Cross-session recall: the full-text index behind the `/search` command, offered to the agent.
 * `session_search` finds past conversations, `session_read` reads one back (its most recent part
 * when it is long, since decisions tend to come last). The current conversation is left out of
 * the search: the model already has it.
 */
export function sessionTools(sessions: SessionService, messages: MessageService): ToolDef[] {
  return [
    {
      name: "session_search",
      description:
        "Cherche dans tes conversations passées (plein texte). À utiliser quand l'utilisateur fait référence à un échange antérieur (« comme la dernière fois », « ce qu'on avait décidé ») ou pour retrouver une solution déjà trouvée. Lis ensuite une conversation avec session_read.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
      },
      source: "builtin",
      async run(args, ctx) {
        const limit = clamp(args.limit, 8, 1, 20);
        const hits = sessions.search(String(args.query), limit + 1).filter((h) => h.sessionId !== ctx.sessionId);
        if (!hits.length) return "Aucune conversation passée ne correspond.";
        return hits
          .slice(0, limit)
          .map((h) => `- ${h.sessionId} · ${day(h.updatedAt)} · ${h.title}${h.snippet ? `\n  ${h.snippet}` : ""}`)
          .join("\n");
      },
    },
    {
      name: "session_read",
      description:
        "Relit une conversation passée (identifiant donné par session_search) : messages de l'utilisateur, réponses et outils appelés. Une longue conversation est rendue par sa fin.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" }, max_chars: { type: "integer" } },
        required: ["session_id"],
      },
      source: "builtin",
      async run(args) {
        const id = String(args.session_id);
        const session = sessions.get(id);
        if (!session) throw new Error(`Conversation introuvable : ${id}`);
        const max = clamp(args.max_chars, DEFAULT_READ_CHARS, 500, MAX_READ_CHARS);
        const body = transcript(messages.list(id), max, (text) =>
          text.length > 2000 ? `${text.slice(0, 2000)} …` : text,
        );
        return `# ${session.title} (${day(session.createdAt)} → ${day(session.updatedAt)})\n\n${body || "(conversation vide)"}`;
      },
    },
  ];
}
