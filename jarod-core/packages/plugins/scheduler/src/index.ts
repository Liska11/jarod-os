/**
 * @jarod/plugin-scheduler — `ctx.scheduler` (tâches planifiées), `ctx.jobs` (file durable),
 * `ctx.webhooks` (déclencheurs entrants signés).
 * Câblage repris de `core.ts:384,516-519,670-671,683,1771`. L'exécution d'un tir passe par
 * l'événement kernel `schedule/run` (plugin-agent s'y branche en Phase 1, comme `runSchedule`).
 */
import { createHash } from "node:crypto";
import { type KernelEvents, type ScheduleRunResult, SchedulerConfig } from "@jarod/contracts";
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { JobsService } from "./jobs.js";
import { type Schedule, Scheduler } from "./scheduler.js";
import { WebhookService, normalizeHookPort } from "./webhooks.js";

export * from "./cron.js";
export * from "./jobs.js";
export * from "./scheduler.js";
export * from "./webhook-runner.js";
export * from "./webhooks.js";

declare module "cordis" {
  interface Context {
    scheduler: Scheduler;
    jobs: JobsService;
    webhooks: WebhookService;
  }
  interface Events extends KernelEvents {}
}

export const name = "scheduler";
export const inject = ["storage"];
export const Config = SchedulerConfig;

/**
 // La gate vivante (SPECS-P5-WEBHOOKS § 4) n'a pas encore été passée : le drapeau de construction
  * est éteint. Le démarrage du serveur (§ 2.1) reste derrière ce drapeau tant que la gate n'a pas
  * été passée. Le drapeau ne passe à « allumé » que par un commit à part, qui cite le journal de
  * la gate.
  * Pour la gate vivante (opt-in GATE_WEBHOOKS_LIVE=1) : le drapeau peut être forcé via
  * l'env var FORCE_WEBHOOKS_GATE=1 (non persisté, test uniquement).
  */
 const WEBHOOKS_GATE_PASSED = process.env.FORCE_WEBHOOKS_GATE === "1";

export function apply(ctx: Context, input: SchedulerConfig): void {
  const config = SchedulerConfig.parse(input ?? {});
  const db = ctx.storage.db;
  const jobs = new JobsService({ db });
  const runner = async (s: Schedule): Promise<ScheduleRunResult> => {
    const r = ((await ctx.serial("schedule/run", s)) as ScheduleRunResult | undefined) ?? {
      sessionId: "",
      ok: false,
      summary: "aucun exécutant branché sur schedule/run",
    };
    ctx.emit("schedule:fired", s, r);
    return r;
  };
  const scheduler = new Scheduler(db, runner);
  scheduler.attachJobs(jobs);
  ctx.provide("jobs", jobs);
  ctx.provide("scheduler", scheduler);

  // WebhookService : fourni à partir de la base et du routeur LLM (si disponible).
  // Le démarrage du serveur est conditionné par le réglage ET la gate vivante.
  const settings = ctx.storage.settings;
  const webhookPort = normalizeHookPort(settings.get("webhooks")?.port);
  const webhooks = new WebhookService({
    db,
    port: webhookPort,
    onHook: (hookId, payload, raw) => {
      // Idempotence : SHA-256 de hookId + corps (SPECS-P5-WEBHOOKS § 2.3).
      // Un rejeu EXACT dans les 10 minutes n'enfile pas une seconde tâche.
      const key = createHash("sha256").update(`${hookId}:${raw}`).digest("hex");
      const existing = jobs.byKey(key);
      if (existing && existing.status !== "failed" && Date.now() - existing.createdAt < 10 * 60_000) {
        return; // Rejeu dans la fenêtre : on ignore
      }
      jobs.enqueue({
        kind: "webhook",
        payload: { hookId, payload },
        idempotencyKey: key,
        maxAttempts: 2,
      });
    },
    router: ctx.get("llm")?.router,
  });
  ctx.provide("webhooks", webhooks);

  ctx.effect(() => {
    // Ce qu'un processus précédent a laissé en vol : un déclencheur repart, un tir planifié est
    // clos (l'horaire a son propre prochain tour) — `core.ts:670-671`.
    jobs.recover(undefined, (job) => job.kind === "webhook");
    jobs.prune();
    if (config.autoStart) scheduler.start(config.tickMs);

    // Démarrage du serveur de déclencheurs : seulement si le réglage est activé ET la gate passée.
    const webhookEnabled = settings.get("webhooks")?.enabled ?? false;
    if (webhookEnabled && WEBHOOKS_GATE_PASSED) {
      void webhooks.start().catch(() => {
        // Le port occupé est une erreur dite, jamais un crash (SPECS-P5-WEBHOOKS § 2.1).
      });
    }

    return () => {
      scheduler.stop();
      void webhooks.stop().catch(() => {});
    };
  }, "scheduler:tick");
}
