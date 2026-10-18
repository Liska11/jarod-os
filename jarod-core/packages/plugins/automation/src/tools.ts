/**
 * Outils agent pour l'automatisation.
 */
import type { ToolDef } from "@jarod/plugin-tools";
import type { AutomationService, AutomationTrigger, AutomationAction } from "./automation.js";

export function automationTools(automation: AutomationService): ToolDef[] {
  return [
    {
      name: "automation_list",
      description: "Liste toutes les règles d'automatisation (id, nom, activée, déclencheur, nombre d'actions).",
      parameters: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Filtrer par état activé/désactivé." },
        },
      },
      source: "builtin",
      async run(args, _ctx) {
        const filter = args.enabled !== undefined ? { enabled: args.enabled as boolean } : undefined;
        const rules = automation.list(filter);
        return rules.map(r => ({
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          trigger: r.trigger,
          actionsCount: r.actions.length,
        })).map((r) => JSON.stringify(r)).join("\n") || "Aucune règle.";
      },
    },
    {
      name: "automation_get",
      description: "Détail complet d'une règle d'automatisation (déclencheur + actions).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identifiant de la règle." },
        },
        required: ["id"],
      },
      source: "builtin",
      async run(args, _ctx) {
        const rule = automation.get(args.id as string);
        if (!rule) return `Règle introuvable : ${args.id}`;
        return JSON.stringify(rule, null, 2);
      },
    },
    {
      name: "automation_create",
      description: "Crée une règle d'automatisation. Exige un accord.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nom lisible de la règle." },
          trigger: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["schedule", "manual"] },
              cron: { type: "string", description: "Expression cron (schedule seulement)." },
            },
            required: ["kind"],
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["agent", "notify"] },
                prompt: { type: "string" },
                sessionId: { type: "string" },
                mode: { type: "string", enum: ["plan", "build"] },
                title: { type: "string" },
                body: { type: "string" },
              },
              required: ["type"],
            },
            minItems: 1,
          },
        },
        required: ["name", "trigger", "actions"],
      },
      source: "builtin",
      dangerous: true, // sensible → accord demandé
      async run(args, _ctx) {
        // Validation basique
        const trigger = args.trigger as AutomationTrigger;
        if (!trigger || (trigger.kind !== "schedule" && trigger.kind !== "manual")) {
          return "Erreur : trigger inconnu (attendu : schedule ou manual).";
        }
        if (trigger.kind === "schedule" && !trigger.cron) {
          return "Erreur : trigger schedule requiert un champ cron.";
        }
        if (trigger.kind === "manual" && trigger.cron) {
          return "Erreur : le trigger manual ne porte pas de cron.";
        }
        const actions = args.actions as AutomationAction[];
        if (!actions.length) return "Erreur : au moins une action requise.";
        for (const a of actions) {
          if (a.type === "agent" && !a.prompt) return "Erreur : action agent requiert un prompt.";
          if (a.type === "notify" && !a.title) return "Erreur : action notify requiert un title.";
        }

        const rule = automation.create({
          name: args.name as string,
          trigger,
          actions,
        });
        return `Règle créée : ${rule.id} (${rule.name})`;
      },
    },
    {
      name: "automation_update",
      description: "Met à jour une règle (nom, activée, déclencheur, actions). Exige un accord.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identifiant de la règle." },
          name: { type: "string" },
          enabled: { type: "boolean" },
          trigger: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["schedule", "manual"] },
              cron: { type: "string" },
            },
            required: ["kind"],
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["agent", "notify"] },
                prompt: { type: "string" },
                sessionId: { type: "string" },
                mode: { type: "string", enum: ["plan", "build"] },
                title: { type: "string" },
                body: { type: "string" },
              },
              required: ["type"],
            },
          },
        },
        required: ["id"],
      },
      source: "builtin",
      dangerous: true,
      async run(args, _ctx) {
        const { id, ...patch } = args as { id: string } & Partial<{ name: string; enabled: boolean; trigger: AutomationTrigger; actions: AutomationAction[] }>;
        // Validation si trigger fourni
        if (patch.trigger && patch.trigger.kind !== "schedule" && patch.trigger.kind !== "manual") {
          return "Erreur : trigger inconnu (attendu : schedule ou manual).";
        }
        if (patch.trigger && patch.trigger.kind === "schedule" && !patch.trigger.cron) {
          return "Erreur : trigger schedule requiert un champ cron.";
        }
        // Validation si actions fournies
        if (patch.actions) {
          for (const a of patch.actions) {
            if (a.type === "agent" && !a.prompt) return "Erreur : action agent requiert un prompt.";
            if (a.type === "notify" && !a.title) return "Erreur : action notify requiert un title.";
          }
        }

        const rule = automation.update(id, patch);
        if (!rule) return `Règle introuvable : ${id}`;
        return `Règle mise à jour : ${rule.id} (${rule.name})`;
      },
    },
    {
      name: "automation_delete",
      description: "Supprime une règle d'automatisation. Exige un accord.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identifiant de la règle." },
        },
        required: ["id"],
      },
      source: "builtin",
      dangerous: true,
      async run(args, _ctx) {
        const ok = automation.delete(args.id as string);
        return ok ? `Règle supprimée : ${args.id}` : `Règle introuvable : ${args.id}`;
      },
    },
    {
      name: "automation_run",
      description: "Déclenche une règle manuellement (exécution immédiate). Exige un accord.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Identifiant de la règle." },
        },
        required: ["id"],
      },
      source: "builtin",
      dangerous: true,
      async run(args, _ctx) {
        const result = await automation.run(args.id as string);
        return result.ok ? `✅ ${result.summary}` : `❌ ${result.summary}`;
      },
    },
  ];
}