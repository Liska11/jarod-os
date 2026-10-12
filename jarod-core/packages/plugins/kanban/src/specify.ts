/**
 * « Spécifier » une tâche `triage` : un appel LLM ponctuel, sans outils, qui transforme une idée brute en
 * fiche exécutable (titre resserré + corps structuré), puis `triage → todo`. Portage de
 * `hermes_cli/kanban_specify.py` (`_SYSTEM_PROMPT`, `_USER_TEMPLATE`, `_extract_json_blob`, `_title_body`) :
 * analyse tolérante — sans objet JSON lisible, la réponse entière devient le corps ; une réponse vide est
 * un échec (la tâche reste en triage).
 */
import type { KanbanTask } from "./kanban.js";

export const SPECIFY_SYSTEM = `Tu es le spécificateur de tri du tableau Kanban de Jarod.
L'utilisateur a déposé une idée brute dans la colonne « Triage ». Ton travail : la transformer en fiche
concrète et exécutable, qu'un agent pourra prendre sans autre précision.

Réponds par un seul objet JSON, avec exactement deux clés :

  {
    "title": "<titre resserré, 80 caractères au plus, à l'impératif>",
    "body":  "<fiche sur plusieurs lignes, structure ci-dessous>"
  }

Le corps DOIT contenir ces sections, chacune précédée d'un intitulé en gras markdown, dans cet ordre :

  **Objectif** — une phrase, le résultat attendu par l'utilisateur.
  **Approche** — 2 à 5 puces sur la manière de s'y prendre.
  **Critères d'acceptation** — liste de conditions concrètes et vérifiables.
  **Hors périmètre** — courte liste de ce qu'il ne faut PAS toucher (à omettre si rien d'évident ; n'invente jamais d'extension).

Règles :
  - Garde le titre proche du sens de l'idée d'origine — n'invente PAS un autre projet.
  - Si l'idée est déjà détaillée, garde sa substance et remets-la simplement dans les sections ci-dessus.
  - N'ajoute jamais d'exigence que l'utilisateur n'a pas suggérée.
  - Pas de préambule, pas de conclusion, pas de bloc de code autour du JSON.
  - Réponds uniquement par l'objet JSON, dans la langue de l'idée.`;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function specifyPrompt(t: Pick<KanbanTask, "id" | "title" | "body">): string {
  return `Tâche : ${t.id}\nTitre actuel : ${clip(t.title, 400)}\nCorps actuel :\n${clip(t.body || "(pas de corps)", 4_000)}\n`;
}

/** `{ title, body }` d'une réponse ; null = réponse vide ou objet sans titre ni corps (échec). Titre nettoyé, corps tel quel. */
export function parseSpecifyReply(raw: string): { title: string | null; body: string | null } | null {
  const text = raw.trim();
  if (!text) return null;
  const stripped = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, "");
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      const v = JSON.parse(stripped.slice(first, last + 1)) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const o = v as Record<string, unknown>;
        const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : null;
        const body = typeof o.body === "string" && o.body.trim() ? o.body : null;
        return title || body ? { title, body } : null;
      }
    } catch {
      // Pas un objet JSON : la réponse entière devient le corps (comme Hermes).
    }
  }
  return { title: null, body: text };
}
