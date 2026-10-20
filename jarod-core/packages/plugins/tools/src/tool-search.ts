// Portage de packages/core/src/services/tool-search.ts (rév. 2e180305).
import type { ToolSpec } from "@jarod/contracts";

/**
 * Tool search (Hermes Agent's `tool_search`): instead of sending every tool schema with every
 * request — several thousand tokens, more than a small local model's whole context — the model gets
 * a core set plus `tool_search`, and the other tools by name in the system prompt. A search returns
 * the matching tools and activates them for the conversation, from the next step on.
 *
 * Only which tools are *offered* changes: running one still goes through the same gate.
 */

/** Always offered: what almost every task needs, and the way to reach the rest. */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "find_files",
  "search_files",
  "run_shell",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_save",
  "user_profile",
  "load_skill",
  "todo",
  "ask_user",
  "present",
  // Cockpit : ce que Jarod sait faire maintenant (registre vivant, lecture seule).
  "capabilities",
  "tool_search",
]);

/**
 * Offered up front, but only while the RAG is switched on (the agent decides): a small local model asked to « indexe X » did not think to
 * look for `rag_index` behind `tool_search` and wrote its own scripts instead (incident of 2026-10-01).
 */
export const RAG_TOOLS: ReadonlySet<string> = new Set(["rag_search", "rag_index"]);

const MAX_ACTIVE = 40;

const words = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

/** Tools matching a free-text query, best first: a word in the name weighs more than in the description. */
export function rankTools(query: string, candidates: ToolSpec[], limit = 5): ToolSpec[] {
  const q = words(query);
  if (!q.length) return [];
  return candidates
    .map((t) => {
      const name = t.name.toLowerCase();
      const desc = words(t.description).join(" ");
      let score = 0;
      for (const w of q) {
        if (name.includes(w)) score += 3;
        else if (desc.includes(w)) score += 1;
      }
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t);
}

export class ToolSearchService {
  private active = new Map<string, Set<string>>();

  activate(sessionId: string, names: string[]): void {
    let set = this.active.get(sessionId);
    if (!set) {
      set = new Set();
      this.active.set(sessionId, set);
    }
    for (const n of names) set.add(n);
    // Oldest first out: a very long conversation cannot grow back to "every tool".
    while (set.size > MAX_ACTIVE) set.delete(set.values().next().value as string);
  }

  activeFor(sessionId: string): ReadonlySet<string> {
    return this.active.get(sessionId) ?? new Set();
  }

  /** The specs offered in lean mode: the core set, `extraCore` (e.g. the RAG tools when the RAG is on) and what this conversation activated. */
  lean(sessionId: string, all: ToolSpec[], extraCore: ReadonlySet<string> = new Set()): ToolSpec[] {
    const active = this.activeFor(sessionId);
    return all.filter((t) => CORE_TOOLS.has(t.name) || extraCore.has(t.name) || active.has(t.name));
  }

  /** The system-prompt paragraph naming the tools that are not offered yet. */
  indexSection(sessionId: string, all: ToolSpec[], extraCore: ReadonlySet<string> = new Set()): string {
    const offered = new Set(this.lean(sessionId, all, extraCore).map((t) => t.name));
    const others = all.filter((t) => !offered.has(t.name)).map((t) => t.name);
    if (!others.length) return "";
    return `## Autres outils\nPour garder les requêtes légères, ces outils ne sont décrits qu'à la demande : cherche avec tool_search (par mot-clé ou par nom) pour les activer, puis appelle-les.\n${others.join(", ")}`;
  }
}
