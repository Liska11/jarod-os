// Portage de packages/core/src/tools/tool-search.ts (rév. 2e180305).
import type { Settings } from "@jarod/plugin-storage";
import { CORE_TOOLS, rankTools, type ToolSearchService } from "./tool-search.js";
import type { ToolDef, ToolRegistry } from "./registry.js";

const describeParams = (parameters: Record<string, unknown>): string => {
  const props = Object.keys((parameters.properties ?? {}) as Record<string, unknown>);
  const required = new Set((parameters.required as string[] | undefined) ?? []);
  return props.map((p) => (required.has(p) ? p : `${p}?`)).join(", ");
};

/**
 * `tool_search`: finds tools by keyword (or exact names) among those not described yet, and
 * activates them for this conversation. Only offered in lean mode (see ToolSearchService).
 */
export function toolSearchTools(
  registry: ToolRegistry,
  search: ToolSearchService,
  settingsFor: (sessionId: string) => Settings,
): ToolDef[] {
  return [
    {
      name: "tool_search",
      description:
        "Trouve et active des outils supplémentaires pour cette conversation (voir « Autres outils »). `query` : mots-clés de ce que tu veux faire (ex. « tâche planifiée », « github issues », « worktree »), ou `names` : noms exacts. Les outils trouvés sont utilisables dès l'étape suivante.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          names: { type: "array", items: { type: "string" } },
        },
      },
      source: "builtin",
      async run(args, ctx) {
        const candidates = registry
          .specs(settingsFor(ctx.sessionId).disabledTools)
          .filter((t) => !CORE_TOOLS.has(t.name));
        const names = Array.isArray(args.names) ? args.names.map(String) : [];
        const byName = candidates.filter((t) => names.includes(t.name));
        const byQuery = typeof args.query === "string" ? rankTools(args.query, candidates, 5) : [];
        const found = [...new Map([...byName, ...byQuery].map((t) => [t.name, t])).values()];
        if (!found.length) {
          return `Aucun outil trouvé. Outils disponibles : ${candidates.map((t) => t.name).join(", ")}`;
        }
        search.activate(
          ctx.sessionId,
          found.map((t) => t.name),
        );
        return `Activés pour cette conversation :\n${found
          .map((t) => `- ${t.name}(${describeParams(t.parameters)}) — ${t.description.slice(0, 220)}`)
          .join("\n")}`;
      },
    },
  ];
}
