/**
 * L'outil `capabilities` de l'agent : lire le registre vivant. Lecture seule, aucune action n'ajoute ni n'exécute une capacité —
 * le texte d'une page ou d'un document ne peut donc rien y déclarer.
 */
import { type CapabilityService, STATE_LABELS } from "./service.js";
import type { CapabilityView } from "./types.js";

/** La forme d'un `ToolDef` de plugin-tools (sans en dépendre). */
export interface CapabilitiesToolDef {
  name: "capabilities";
  description: string;
  parameters: Record<string, unknown>;
  dangerous: false;
  source: "builtin";
  run(args: Record<string, unknown>, ctx: { sessionId: string; workspace: string | null }): Promise<string>;
}

const line = (c: CapabilityView) =>
  `${c.id} — ${STATE_LABELS[c.state]}${c.version ? ` ${c.version}` : ""}${c.experimental ? " (expérimentale)" : ""} : ${c.name} [${c.integration}]`;

function detail(c: CapabilityView): string {
  return [
    line(c),
    c.description,
    `état : ${c.detail}`,
    c.missing?.length ? `manque : ${c.missing.join(", ")}` : "",
    c.tools.length ? `outils : ${c.tools.map((t) => `${t} (${c.permissions[t] ?? "?"})`).join(", ")}` : "aucun outil ne l'exécute",
    `risque : ${c.risk} ; lieu : ${c.locality} ; effets : ${c.sideEffects}`,
    c.requires.length ? `exige : ${c.requires.join(", ")}` : "",
    `vérification : ${c.verification}`,
    `limites : ${c.limits.join(" ; ")}`,
    c.provenance ? `provenance : ${c.provenance.repo} @ ${c.provenance.pinned} (${c.provenance.license})` : "",
    c.provenance?.stage ? `étape : ${c.provenance.stage}${c.provenance.stageReason ? ` — ${c.provenance.stageReason}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function capabilitiesTool(service: CapabilityService): CapabilitiesToolDef {
  return {
    name: "capabilities",
    description:
      "Ce que Jarod sait faire maintenant, vérifié par sonde : list (manifeste compact), search (par intention), describe (détail d'une capacité), check (resonder).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "search", "describe", "check"] },
        id: { type: "string", description: "identifiant de capacité (describe, check)" },
        query: { type: "string", description: "intention en langage courant (search)" },
      },
      required: ["action"],
    },
    dangerous: false,
    source: "builtin",
    async run(args) {
      const action = String(args.action ?? "");
      const id = typeof args.id === "string" ? args.id : "";
      if (action === "list") {
        const all = await service.list();
        const own = all.filter((c) => !c.id.startsWith("tool."));
        const tools = all.filter((c) => c.id.startsWith("tool."));
        const blocked = tools.filter((t) => t.state !== "available").length;
        return [
          ...own.map(line),
          tools.length ? `outils intégrés : ${tools.length - blocked} disponibles, ${blocked} bloqués (describe tool.<nom>)` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
      if (action === "search") {
        const found = await service.search(String(args.query ?? ""));
        return found.length ? found.slice(0, 8).map(line).join("\n") : "Aucune capacité du catalogue ne correspond.";
      }
      if (action === "describe" || action === "check") {
        if (!id) return "Argument id requis.";
        const c = action === "describe" ? await service.describe(id) : await service.check(id);
        if (!c || c.state === "unknown") return `Capacité inconnue : ${id}. Le catalogue est celui du code ; utilisez list ou search.`;
        return detail(c);
      }
      return "Action inconnue : list, search, describe ou check.";
    },
  };
}
