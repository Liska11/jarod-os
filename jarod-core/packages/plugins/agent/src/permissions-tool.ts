// Autonomie configurable (2026-10-21) : ce que l'agent sait de ses PERMISSIONS, en lecture seule. Il peut dire « je sais faire cette action, mais
// cette permission manque » et donner la commande que l'UTILISATEUR taperait — jamais l'accorder lui-même : aucun outil n'écrit les règles.
import type { PermissionRule } from "@jarod/contracts";
import { describeRule, explainResolution, reservedReason, type ToolGate } from "@jarod/plugin-permissions";
import type { ToolDef, ToolRegistry } from "@jarod/plugin-tools";
import { NEVER_ALWAYS_REASONS } from "./never-always.js";

export function permissionsExplainTool(tools: ToolRegistry, gate: () => ToolGate | undefined, rules: () => readonly PermissionRule[]): ToolDef {
  return {
    name: "permissions_explain",
    description:
      "Lecture seule : dit si un outil serait autorisé, demandé ou refusé pour une cible et une opération données, et pourquoi (quelle règle, quelle borne) ; sans `tool`, liste les règles de l'utilisateur. Sert à répondre « je sais faire, mais cette permission manque » au lieu de « je ne sais pas ». Ne modifie rien : seul l'utilisateur change une permission (Réglages, ou la commande jarod permissions dans son terminal).",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Nom de l'outil (ex. system_files, media_fetch)." },
        target: { type: "string", description: "La cible : un chemin, un hôte, une application." },
        operation: { type: "string", description: "L'opération (ex. subtitles, sql)." },
      },
    },
    source: "builtin",
    run: async (args, ctx) => {
      const now = Date.now();
      const name = typeof args.tool === "string" ? args.tool.trim() : "";
      if (!name) {
        const list = rules();
        return list.length
          ? ["Règles de l'utilisateur (la première qui couvre un appel gagne) :", ...list.map((r, i) => `  ${describeRule(r, i + 1, now)}`)].join("\n")
          : "Aucune règle de l'utilisateur : un outil déclaré est permis ; un outil sensible demande l'accord à chaque appel.";
      }
      const g = gate();
      if (!g?.resolve) return "Indisponible : aucune politique de permissions n'est branchée ici.";
      const target = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
      const operation = typeof args.operation === "string" && args.operation.trim() ? args.operation.trim() : null;
      const call = { targets: target ? [target] : null, operation, session: ctx.sessionId };
      const res = g.resolve(name, call);
      const t = tools.get(name);
      const e = explainResolution(
        name,
        call,
        res,
        { exists: Boolean(t), dangerous: Boolean(t?.dangerous), restricted: reservedReason(res, operation, t?.restrictedOperations), neverAlways: NEVER_ALWAYS_REASONS[name] ?? null },
        now,
      );
      return [`${name}${target ? ` sur « ${target} »` : ""}${operation ? `, opération « ${operation} »` : ""} : ${e.verdict}`, e.why, e.howTo ?? ""].filter(Boolean).join("\n");
    },
  };
}
