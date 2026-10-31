// H2 : l'outil `ask_user` — l'agent pose une question, éventuellement à choix, dans l'interface (requête serveur `clarify` de Hermes) et reprend avec la réponse.
// Idée du `clarify` de Hermes ; code propre à Jarod. La question n'a aucun effet : elle ne demande pas d'accord, elle demande un avis.
import type { ToolDef } from "@jarod/plugin-tools";

export const ASK_QUESTION_MAX = 500;
export const ASK_CHOICES_MAX = 8;
export const ASK_CHOICE_MAX = 120;
export const ASK_ANSWER_MAX = 2000;

function choicesOf(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("« choices » doit être une liste de textes.");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of raw) {
    const text = String(c ?? "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.slice(0, ASK_CHOICE_MAX));
  }
  if (out.length > ASK_CHOICES_MAX) throw new Error(`Trop de choix (${ASK_CHOICES_MAX} au plus) : regroupe-les, ou pose une question ouverte.`);
  return out;
}

export function askUserTool(): ToolDef {
  return {
    name: "ask_user",
    description:
      "Pose UNE question à l'utilisateur dans l'interface et attend sa réponse. Avec `choices`, il clique sur un choix (il peut toujours répondre autrement). " +
      "À utiliser quand une décision lui appartient et que la deviner serait risqué ou coûteux (quel fichier, quelle option, quel compte) ; pas pour demander la permission d'un outil, qui a sa propre demande d'accord.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "La question, courte et précise" },
        choices: { type: "array", items: { type: "string" }, description: `Les réponses proposées (${ASK_CHOICES_MAX} au plus)` },
        multi_select: { type: "boolean", description: "true : plusieurs choix possibles" },
      },
      required: ["question"],
    },
    source: "builtin",
    dangerous: false,
    async run(args, ctx) {
      const question = String(args.question ?? "").replace(/\s+/g, " ").trim();
      if (!question) throw new Error("« question » est vide.");
      if (!ctx.ask) {
        return "Personne ne peut répondre ici (tâche planifiée, sous-agent ou client sans interface) : choisis la option la plus prudente et dis-le dans ta réponse.";
      }
      const choices = choicesOf(args.choices);
      const answer = await ctx.ask({
        question: question.slice(0, ASK_QUESTION_MAX),
        ...(choices.length ? { choices } : {}),
        ...(args.multi_select === true && choices.length ? { multiSelect: true } : {}),
      });
      if (answer === null) return "Aucune réponse de l'utilisateur (délai dépassé, ou fenêtre fermée) : ne devine pas, propose-lui de reprendre.";
      const text = answer.trim();
      if (!text) return "L'utilisateur a passé la question sans répondre : continue avec le choix le plus prudent et dis-le.";
      return `Réponse de l'utilisateur : ${text.slice(0, ASK_ANSWER_MAX)}`;
    },
  };
}
