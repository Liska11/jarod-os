// SPECS-P5-ACP.md §3 (côté éditeur) : correspondance PURE entre les événements de l'agent de Jarod (`AgentEvent`) et les mises à jour de session ACP
// (`session/update`). Aucun accès réseau, aucune entrée-sortie : testable seul. Formes vérifiées contre le schéma du SDK ACP 1.5.0 (protocole 1).
// Tout texte qui part vers l'éditeur passe par `redactText` ; les sorties d'outils sont tronquées.
import type { ToolCall } from "@jarod/contracts";
import { redactText } from "@jarod/kernel/redact";
import type { AgentEvent } from "@jarod/plugin-agent";

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
export interface AcpText {
  type: "text";
  text: string;
}
export type AcpUpdate =
  | { sessionUpdate: "user_message_chunk"; content: AcpText }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "agent_message_chunk"; content: AcpText }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpText }
  | { sessionUpdate: "tool_call"; toolCallId: string; title: string; kind: AcpToolKind; status: "pending"; rawInput: unknown }
  | { sessionUpdate: "tool_call_update"; toolCallId: string; status: "completed" | "failed"; content: { type: "content"; content: AcpText }[] };

/** Bornes (SPECS-P5-ACP.md §3) : le résultat d'un outil peut être énorme, l'éditeur n'a pas à le recevoir en entier. */
export const MAX_TOOL_OUTPUT_CHARS = 4_000;
const MAX_ARG_CHARS = 1_000;
const MAX_TITLE_CHARS = 160;

const KINDS: Record<string, AcpToolKind> = {
  read_file: "read", list_dir: "read", read_skill_file: "read", session_read: "read", annotations_list: "read", vault_list: "read",
  state_get: "read", state_list: "read", diff_numbered: "read", subagent_list: "read", subagent_result: "read", refine_history: "read",
  write_file: "edit", edit_file: "edit", annotate_line: "edit", annotation_remove: "edit", refine: "edit", refine_rollback: "edit",
  state_set: "edit", memory_save: "edit", skill_manage: "edit", user_profile: "edit", present: "edit", compact: "edit",
  state_delete: "delete",
  find_files: "search", search_files: "search", rag_search: "search", memory_search: "search", session_search: "search", web_search: "search",
  tool_search: "search", skill_hub_search: "search", load_skill: "read",
  run_shell: "execute", spawn_subagent: "execute", delegate_task: "execute", cronjob: "execute", cronjob_list: "read",
  local_model_server: "execute", subagent_cancel: "execute", docling: "execute", pdfium: "execute", rag_index: "execute",
  web_fetch: "fetch", http_request: "fetch", skill_hub_install: "fetch",
};

/** Genre d'outil pour l'éditeur (icône, regroupement). Inconnu — dont tout outil MCP externe — = `other`. */
export const toolKindOf = (name: string): AcpToolKind => KINDS[name] ?? "other";

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[tronqué]` : s);
const clean = (s: string): string => redactText(s);

/** Copie des arguments d'un appel, expurgée (chaînes), bornée (chaînes longues). Jamais la valeur d'origine. */
export function redactArgs(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return cut(clean(value), MAX_ARG_CHARS);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactArgs(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([k, v]) => [k, redactArgs(v, depth + 1)]));
}

/** Titre lisible d'un appel d'outil : le nom, puis le premier argument textuel court (chemin, commande, requête). */
export function toolTitle(call: Pick<ToolCall, "name" | "args">): string {
  const first = Object.values(call.args ?? {}).find((v): v is string => typeof v === "string" && v.trim() !== "");
  const arg = first ? ` : ${clean(first).replace(/\s+/g, " ")}` : "";
  return cut(`${call.name}${arg}`, MAX_TITLE_CHARS);
}

/** Mise à jour « appel d'outil annoncé » — réutilisée par la demande d'autorisation (même identifiant). */
export const toolCallStart = (call: ToolCall): Extract<AcpUpdate, { sessionUpdate: "tool_call" }> => ({
  sessionUpdate: "tool_call",
  toolCallId: call.id,
  title: toolTitle(call),
  kind: toolKindOf(call.name),
  status: "pending",
  rawInput: redactArgs(call.args),
});

const text = (t: string): AcpText => ({ type: "text", text: t });

/**
 * Événement de l'agent → mises à jour ACP. Seuls quatre événements parlent à l'éditeur : texte, réflexion, début d'outil, résultat d'outil
 * (et `error`, rendu comme un message). `status`, `done`, `history`, `stream-*`… n'ont pas d'équivalent : `[]`.
 * Les messages `user` et `assistant` sont ignorés : l'éditeur a déjà reçu leur texte en morceaux (`delta`).
 */
export function mapAgentEvent(e: AgentEvent): AcpUpdate[] {
  switch (e.type) {
    case "delta": {
      const out: AcpUpdate[] = [];
      if (e.thinking) out.push({ sessionUpdate: "agent_thought_chunk", content: text(clean(e.thinking)) });
      if (e.text) out.push({ sessionUpdate: "agent_message_chunk", content: text(clean(e.text)) });
      return out;
    }
    case "tool-start":
      return [toolCallStart(e.call)];
    case "message": {
      const m = e.message;
      if (m.role !== "tool" || !m.toolCallId) return [];
      return [
        {
          sessionUpdate: "tool_call_update",
          toolCallId: m.toolCallId,
          status: m.isError ? "failed" : "completed",
          content: [{ type: "content", content: text(cut(clean(m.content ?? ""), MAX_TOOL_OUTPUT_CHARS)) }],
        },
      ];
    }
    case "error":
      return [{ sessionUpdate: "agent_message_chunk", content: text(`\n\nErreur : ${cut(clean(e.error), 1_000)}\n`) }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Prompt de l'éditeur → texte pour l'agent.

export class UnsupportedPromptError extends Error {}

type Block =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string } }
  | { type: string; [k: string]: unknown };

/** Taille maximale d'une ressource intégrée qu'on transmet à l'agent (le reste est signalé coupé). */
export const MAX_EMBEDDED_CHARS = 100_000;

/**
 * Blocs du prompt ACP → un texte. Pris en charge : texte, lien de ressource (référence), ressource intégrée TEXTE. Images, audio et ressources
 * binaires sont refusés avec un message clair (la capacité `image` est annoncée fausse) : jamais ignorés en silence.
 */
export function promptToText(blocks: readonly Block[]): string {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new UnsupportedPromptError("Prompt vide.");
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") parts.push((b as { text: string }).text);
    else if (b.type === "resource_link" && typeof (b as { uri?: unknown }).uri === "string") {
      const l = b as { uri: string; name?: string };
      parts.push(`[Fichier référencé : ${l.name ? `${l.name} — ` : ""}${l.uri}]`);
    } else if (b.type === "resource") {
      const r = (b as { resource?: { uri?: string; text?: string; blob?: string } }).resource;
      if (!r || typeof r.text !== "string") throw new UnsupportedPromptError("Ressource binaire non prise en charge (texte seulement).");
      const body = r.text.length > MAX_EMBEDDED_CHARS ? `${r.text.slice(0, MAX_EMBEDDED_CHARS)}\n…[tronqué]` : r.text;
      parts.push(`[Contenu de ${r.uri ?? "ressource"}]\n${body}\n[Fin de ${r.uri ?? "ressource"}]`);
    } else throw new UnsupportedPromptError(`Bloc « ${String(b.type)} » non pris en charge (texte, liens et ressources texte seulement).`);
  }
  return parts.join("\n\n");
}
