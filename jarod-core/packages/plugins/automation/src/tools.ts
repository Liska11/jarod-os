/**
 * Outils agent pour l'automatisation.
 */
import { isAbsolute } from "node:path";
import type { ToolDef } from "@jarod/plugin-tools";
import type { AutomationService, AutomationTrigger, AutomationAction } from "./automation.js";
import { parseWebhookUrl } from "./webhook.js";

/** Ce que doit porter chaque action pour pouvoir tourner ; un texte d'erreur pour le modèle, ou null. */
export function actionProblem(a: AutomationAction): string | null {
  if (a.type === "agent" && !a.prompt) return "Erreur : action agent requiert un prompt.";
  if (a.type === "notify" && !a.title) return "Erreur : action notify requiert un title.";
  if (a.type === "webhook") {
    try {
      parseWebhookUrl(a.url ?? "");
    } catch (e) {
      return `Erreur : action webhook : ${(e as Error).message}`;
    }
  }
  return null;
}

/** Les destinations d'envoi d'une liste d'actions, sans la partie après « ? » (elle peut porter un secret) : ce que la demande d'accord montre. */
export function webhookTargets(actions: unknown): string[] {
  if (!Array.isArray(actions)) return [];
  const out: string[] = [];
  for (const a of actions as AutomationAction[]) {
    if (a?.type !== "webhook") continue;
    try {
      const u = parseWebhookUrl(a.url ?? "");
      out.push(`${u.origin}${u.pathname}`);
    } catch {
      out.push(String(a.url ?? "(adresse manquante)"));
    }
  }
  return out;
}

const sendsTo = (verb: string, name: unknown, actions: unknown): string | void => {
  const targets = webhookTargets(actions);
  if (targets.length) return `${verb}${typeof name === "string" && name ? ` « ${name} »` : ""} : envoie des données à ${targets.join(", ")}`;
};

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
      description: "Crée une règle d'automatisation. Exige un accord. Déclencheurs : schedule (cron), manual, folder (un nouveau fichier dans un dossier surveillé). Actions : agent (un prompt), notify (une notification), webhook (un POST JSON vers une adresse http(s) publique ; jamais la machine locale).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nom lisible de la règle." },
          trigger: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["schedule", "manual", "folder"] },
              folder: { type: "string", description: "folder seulement : dossier surveillé (chemin absolu). Chaque nouveau fichier lance les actions ; dans le prompt, {fichier} est remplacé par son chemin." },
              extensions: { type: "array", items: { type: "string" }, description: "folder seulement : extensions retenues (ex. .wav, .mp3)." },
              cron: { type: "string", description: "Expression cron (schedule seulement)." },
            },
            required: ["kind"],
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["agent", "notify", "webhook"] },
                prompt: { type: "string" },
                sessionId: { type: "string" },
                mode: { type: "string", enum: ["plan", "build"] },
                title: { type: "string" },
                body: { type: "string" },
                url: { type: "string", description: "webhook seulement : adresse http(s) publique qui reçoit le POST." },
                payload: { description: "webhook seulement : le corps JSON envoyé ; absent = le nom de la règle et l'heure." },
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
      precheck: (args) => sendsTo("Créer la règle", args.name, args.actions),
      async run(args, _ctx) {
        // Validation basique
        const trigger = args.trigger as AutomationTrigger;
        if (!trigger || (trigger.kind !== "schedule" && trigger.kind !== "manual" && trigger.kind !== "folder")) {
          return "Erreur : trigger inconnu (attendu : schedule, manual ou folder).";
        }
        if (trigger.kind === "folder" && (!trigger.folder || !isAbsolute(trigger.folder))) {
          return "Erreur : trigger folder requiert un champ folder (chemin absolu d'un dossier).";
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
          const problem = actionProblem(a);
          if (problem) return problem;
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
              kind: { type: "string", enum: ["schedule", "manual", "folder"] },
              folder: { type: "string", description: "folder seulement : dossier surveillé (chemin absolu). Chaque nouveau fichier lance les actions ; dans le prompt, {fichier} est remplacé par son chemin." },
              extensions: { type: "array", items: { type: "string" }, description: "folder seulement : extensions retenues (ex. .wav, .mp3)." },
              cron: { type: "string" },
            },
            required: ["kind"],
          },
          actions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["agent", "notify", "webhook"] },
                prompt: { type: "string" },
                sessionId: { type: "string" },
                mode: { type: "string", enum: ["plan", "build"] },
                title: { type: "string" },
                body: { type: "string" },
                url: { type: "string", description: "webhook seulement : adresse http(s) publique qui reçoit le POST." },
                payload: { description: "webhook seulement : le corps JSON envoyé." },
              },
              required: ["type"],
            },
          },
        },
        required: ["id"],
      },
      source: "builtin",
      dangerous: true,
      precheck: (args) => sendsTo("Modifier la règle", args.name ?? args.id, args.actions),
      async run(args, _ctx) {
        const { id, ...patch } = args as { id: string } & Partial<{ name: string; enabled: boolean; trigger: AutomationTrigger; actions: AutomationAction[] }>;
        // Validation si trigger fourni
        if (patch.trigger && patch.trigger.kind !== "schedule" && patch.trigger.kind !== "manual" && patch.trigger.kind !== "folder") {
          return "Erreur : trigger inconnu (attendu : schedule, manual ou folder).";
        }
        if (patch.trigger && patch.trigger.kind === "schedule" && !patch.trigger.cron) {
          return "Erreur : trigger schedule requiert un champ cron.";
        }
        // Validation si actions fournies
        if (patch.actions) {
          for (const a of patch.actions) {
            const problem = actionProblem(a);
            if (problem) return problem;
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