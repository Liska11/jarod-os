/**
 * @jarod/plugin-automation — `ctx.automation` : règles d'automatisation (schedule + manual),
 * tick séquentiel via jobs durable, outils agent CRUD + run.
 * Ordre : après scheduler (utilise ctx.jobs).
 */
import { type KernelEvents, type ScheduleDto, type ScheduleRunResult } from "@jarod/contracts";
import type {} from "@jarod/plugin-tools";
import { type Context } from "cordis";
import { AutomationService } from "./automation.js";
import { automationTools } from "./tools.js";
import { normalizeAutomationTickMs } from "./normalize.js";

export * from "./automation.js";
export * from "./tools.js";
export * from "./normalize.js";

declare module "cordis" {
  interface Context {
    automation: AutomationService;
  }
  interface Events extends KernelEvents {
    /** Journal des ticks de l'automatisation (une ligne par action enfilée / exécutée). */
    "automation:log"(line: string): void;
  }
}

export const name = "automation";
// `tools` déclaré : cordis refuse l'accès à une propriété non injectée (sinon les outils agent
// ne sont jamais enregistrés — `ctx.get("tools")` rendait undefined en silence).
export const inject = ["storage", "scheduler", "jobs", "tools"];

export interface AutomationConfig {
  /** Période du tick en ms (défaut 30 000, borné [1000, 3_600_000]). */
  tickMs?: number;
}

export function apply(ctx: Context, config: AutomationConfig = {}): void {
  const db = ctx.storage.db;
  const jobs = ctx.jobs;
  const settings = ctx.storage.settings;

  const tickMs = normalizeAutomationTickMs(settings.get("automationTickMs") ?? config.tickMs);

  const automation = new AutomationService({
    db,
    jobs,
    runAgent: async (prompt, sessionId, mode) => {
      // Délègue à l'agent via l'événement kernel schedule/run (même chemin que les tâches planifiées)
      const schedule: ScheduleDto = {
        id: `automation-${Date.now()}`,
        name: "Automation",
        prompt,
        spec: { kind: "once", at: Date.now() },
        sessionId: sessionId ?? null,
        enabled: true,
        lastRun: null,
        nextRun: null,
        lastStatus: null,
        deliver: null,
        createdAt: Date.now(),
        mode,
      };
      const r = (await ctx.serial("schedule/run", schedule)) as ScheduleRunResult | undefined;
      return r ?? { sessionId: sessionId ?? "", ok: false, summary: "Aucun exécutant branché sur schedule/run" };
    },
    notify: (kind, title, body) => {
      ctx.storage.notifications.add(kind, title, body);
    },
    log: (line) => ctx.emit("automation:log", line),
  });

  ctx.provide("automation", automation);

  // Enregistre les outils agent (si plugin-tools chargé)
  const tools = ctx.get("tools")?.registry;
  if (tools) {
    for (const t of automationTools(automation)) tools.register(t);
  }

  // Démarre le tick avec le noyau
  ctx.effect(() => {
    // Récupération au démarrage : jobs running → pending (reprise)
    jobs.recover(undefined, (job) => job.kind === "automation");
    jobs.prune();

    automation.start(tickMs);
    return () => automation.stop();
  }, "automation:tick");
}