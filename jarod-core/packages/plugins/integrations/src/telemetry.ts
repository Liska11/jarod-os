/**
 * Épurateur d'attributs de trace (R3). Les traces du noyau (conversation.turn → model.select → llm.request →
 * tool.permission.wait → subagent.run → memory.checkpoint) ne portent QUE : identifiants opaques, durées, tailles,
 * statuts et catégories d'erreur. Jamais un prompt, une clé, un chemin, une réponse.
 *
 * Liste blanche par NOM d'attribut ET par forme de valeur : un attribut autorisé dont la valeur ressemble à un
 * chemin, à une URL ou à une clé est écarté quand même. Tout ce qui n'est pas explicitement permis est supprimé
 * (et compté), pas masqué : un masque laisse deviner la forme de ce qu'il cache.
 */

export const SPAN_NAMES = ["conversation.turn", "model.select", "llm.request", "tool.call", "tool.permission.wait", "tool.execute", "subagent.run", "memory.checkpoint"] as const;

const ALLOWED: Record<string, "id" | "number" | "status" | "category"> = {
  "session.id": "id",
  "turn.id": "id",
  "tool.name": "category",
  "model.provider": "category",
  "duration.ms": "number",
  "input.size": "number",
  "output.size": "number",
  "tool.count": "number",
  "status": "status",
  "error.category": "category",
  "decision": "status",
};

const SHAPES = {
  id: /^[A-Za-z0-9_-]{4,64}$/,
  category: /^[a-z][a-z0-9_.-]{0,40}$/,
  status: /^(ok|error|denied|granted|timeout|cancelled|allow|ask|deny)$/,
};

const SUSPICIOUS = /([A-Za-z]:\\|\\\\|\/(?:home|users|etc|var)\/|https?:\/\/|\bsk-[A-Za-z0-9]|\bghp_|AKIA[0-9A-Z]{8}|\.ssh|\s)/i;

export interface Scrubbed {
  attributes: Record<string, string | number>;
  dropped: number;
}

export function scrubAttributes(input: Record<string, unknown>): Scrubbed {
  const attributes: Record<string, string | number> = {};
  let dropped = 0;
  for (const [name, value] of Object.entries(input)) {
    const kind = ALLOWED[name];
    if (!kind) {
      dropped += 1;
      continue;
    }
    if (kind === "number") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) attributes[name] = value;
      else dropped += 1;
      continue;
    }
    if (typeof value !== "string" || SUSPICIOUS.test(value) || !SHAPES[kind].test(value)) {
      dropped += 1;
      continue;
    }
    attributes[name] = value;
  }
  return { attributes, dropped };
}
