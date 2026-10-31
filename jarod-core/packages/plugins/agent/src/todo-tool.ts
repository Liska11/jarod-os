// H11 : l'outil `todo` — le plan de la mission que l'agent tient à jour, montré en direct dans la page « Missions » (`todo.updated`).
// Idée du `todo` de Hermes (liste de tâches de la conversation, instantané complet à chaque appel) ; code propre à Jarod, sur l'état de travail existant.
import type { ToolDef } from "@jarod/plugin-tools";
import type { SessionStateService } from "./session-state.js";

export const TODO_STATE_KEY = "todos";
export const TODO_MAX_ITEMS = 30;
export const TODO_CONTENT_MAX = 200;
export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoState {
  todos: TodoItem[];
  revision: number;
}

function clean(raw: unknown, index: number): TodoItem {
  if (!raw || typeof raw !== "object") throw new Error(`Tâche ${index + 1} : un objet {id, content, status} est attendu.`);
  const r = raw as Record<string, unknown>;
  const content = String(r.content ?? "").replace(/\s+/g, " ").trim();
  if (!content) throw new Error(`Tâche ${index + 1} : « content » est vide.`);
  const status = String(r.status ?? "pending");
  if (!(TODO_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Tâche ${index + 1} : état « ${status} » inconnu (${TODO_STATUSES.join(", ")}).`);
  }
  const id = String(r.id ?? "").trim() || String(index + 1);
  return { id: id.slice(0, 40), content: content.slice(0, TODO_CONTENT_MAX), status: status as TodoStatus };
}

/** Une seule tâche en cours à la fois : c'est ce que la page Missions montre comme « étape courante ». */
function check(items: TodoItem[]): void {
  if (items.length > TODO_MAX_ITEMS) throw new Error(`Trop de tâches (${TODO_MAX_ITEMS} au plus) : regroupe-les.`);
  const ids = new Set<string>();
  for (const t of items) {
    if (ids.has(t.id)) throw new Error(`Identifiant « ${t.id} » en double.`);
    ids.add(t.id);
  }
  if (items.filter((t) => t.status === "in_progress").length > 1) throw new Error("Une seule tâche peut être « in_progress » à la fois.");
}

function read(state: SessionStateService, sessionId: string): TodoState {
  const v = state.get(sessionId, TODO_STATE_KEY) as Partial<TodoState> | undefined;
  return { todos: Array.isArray(v?.todos) ? (v.todos as TodoItem[]) : [], revision: typeof v?.revision === "number" ? v.revision : 0 };
}

export function todoTool(state: SessionStateService): ToolDef {
  return {
    name: "todo",
    description:
      "Tient le plan de la mission en cours : une liste de tâches (id, content, status) que l'utilisateur voit se cocher en direct. " +
      "Sans `todos`, rend la liste actuelle. Avec `todos`, la remplace (ou, avec merge=true, met à jour par id et ajoute les nouvelles). " +
      "États : pending, in_progress (une seule à la fois), completed, cancelled. À utiliser pour les travaux de plus de trois étapes.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: [...TODO_STATUSES] },
            },
            required: ["content"],
          },
        },
        merge: { type: "boolean", description: "true : met à jour par id au lieu de remplacer toute la liste" },
      },
    },
    source: "builtin",
    dangerous: false,
    async run(args, ctx) {
      const current = read(state, ctx.sessionId);
      if (args.todos === undefined) return JSON.stringify(current);
      if (!Array.isArray(args.todos)) throw new Error("« todos » doit être une liste.");
      const incoming = args.todos.map(clean);
      let next: TodoItem[];
      if (args.merge === true) {
        next = current.todos.map((t) => incoming.find((i) => i.id === t.id) ?? t);
        for (const i of incoming) if (!next.some((t) => t.id === i.id)) next.push(i);
      } else {
        next = incoming;
      }
      check(next);
      const saved: TodoState = { todos: next, revision: current.revision + 1 };
      state.set(ctx.sessionId, TODO_STATE_KEY, saved, "json");
      ctx.notify?.("todo.updated", { todos: saved.todos, revision: saved.revision });
      return JSON.stringify(saved);
    },
  };
}
