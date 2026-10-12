// Portage de packages/core/src/tools/cron.ts (rév. 2e180305).
import {
  DELIVERY_GATEWAYS,
  describeSpec,
  type Schedule,
  type ScheduleDelivery,
  type Scheduler,
  type ScheduleSpec,
} from "@jarod/plugin-scheduler";
import type { ToolContext, ToolDef } from "@jarod/plugin-tools";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function describeSchedule(s: Schedule): string {
  const next = s.enabled && s.nextRun ? new Date(s.nextRun).toLocaleString("fr-FR") : "désactivée";
  const deliver = s.deliver ? ` · livrée sur ${s.deliver.gateway}:${s.deliver.chatId}` : "";
  const status = s.lastStatus ? ` · dernier résultat : ${s.lastStatus}` : "";
  return `- ${s.id} · **${s.name}** — ${describeSpec(s.spec)} · prochaine : ${next}${deliver}${status}\n  ${s.prompt.slice(0, 160)}`;
}

/** One of `cron`, `every_minutes` or `at` (ISO date) becomes the schedule; none → undefined. */
function specFrom(args: Record<string, unknown>): ScheduleSpec | undefined {
  const given = ["cron", "every_minutes", "at"].filter(
    (k) => args[k] !== undefined && args[k] !== null && args[k] !== "",
  );
  if (given.length > 1) throw new Error("Donne une seule planification : cron, every_minutes ou at.");
  if (str(args.cron)) return { kind: "cron", expr: str(args.cron)! };
  if (typeof args.every_minutes === "number") return { kind: "interval", minutes: args.every_minutes };
  if (str(args.at)) {
    const at = Date.parse(str(args.at)!);
    if (Number.isNaN(at))
      throw new Error(`Date illisible : ${String(args.at)} (format ISO attendu, ex. 2026-10-01T09:00).`);
    return { kind: "once", at };
  }
  return undefined;
}

/** `here` (the chat this conversation comes from), `none`, or `gateway:chatId`. */
function deliveryFrom(raw: unknown, origin: ScheduleDelivery | null): ScheduleDelivery | null | undefined {
  const v = str(raw);
  if (v === undefined) return undefined;
  if (v === "none") return null;
  if (v === "here") {
    if (!origin)
      throw new Error(
        "Cette conversation ne vient pas d'une messagerie : précise telegram:<id>, discord:<id> ou slack:<id>.",
      );
    return origin;
  }
  const m = /^(\w+):(.+)$/.exec(v);
  if (!m || !DELIVERY_GATEWAYS.includes(m[1] as ScheduleDelivery["gateway"])) {
    throw new Error(
      `Livraison invalide : ${v} (here, none, telegram:<id>, discord:<id>, slack:<id>, email:<adresse> ou whatsapp:<numéro>).`,
    );
  }
  return { gateway: m[1] as ScheduleDelivery["gateway"], chatId: m[2]! };
}

const sameTarget = (a: ScheduleDelivery, b: ScheduleDelivery): boolean =>
  a.gateway === b.gateway && a.chatId.trim().toLowerCase() === b.chatId.trim().toLowerCase();

/**
 * Q19-3 (b) — la sortie d'une tâche part à chaque exécution vers un destinataire : hors du chat d'origine de la
 * conversation, c'est un envoi vers un TIERS (une adresse e-mail, un numéro, un autre chat). Il est donc CONFIRMÉ À
 * LA CRÉATION (ou au changement de cible) par la porte d'accord nommée du cœur — celle des outils dangereux, jamais
 * une seconde. Sans porte d'accord (passerelle, tâche, sous-agent) ou sur refus : la tâche n'est pas enregistrée.
 * Le chat d'origine et « aucune livraison » n'ont rien à confirmer.
 */
async function confirmDelivery(
  ctx: ToolContext,
  task: string,
  target: ScheduleDelivery | null | undefined,
  origin: ScheduleDelivery | null,
): Promise<void> {
  if (!target || (origin && sameTarget(target, origin))) return;
  const where = `${target.gateway}:${target.chatId}`;
  const call = { id: `cronjob-delivery-${target.gateway}`, name: "cronjob/deliver", args: { task, gateway: target.gateway, chatId: target.chatId } };
  const granted = ctx.approve
    ? await ctx.approve(
        ctx.sessionId,
        call,
        `Livrer le résultat de la tâche planifiée « ${task} » sur ${where}${origin ? `, et non dans le chat d'origine (${origin.gateway}:${origin.chatId})` : ""}. Chaque exécution enverra sa sortie à ce destinataire.`,
      )
    : false;
  if (!granted) {
    throw new Error(
      `Livraison sur ${where} non confirmée : un destinataire autre que le chat d'origine demande l'accord de l'utilisateur, donné à la création. La tâche n'a pas été enregistrée ; sans \`deliver\`, elle répond dans sa conversation${origin ? " et dans le chat d'origine" : ""}.`,
    );
  }
}

/**
 * Scheduled tasks, for the agent. It turns "every weekday at 9" into a cron expression itself.
 * Listing is read-only; creating, changing or deleting a task is `dangerous` (approval gate): a
 * task runs the agent, with its tools, unattended. A task created from a Telegram, Discord or Slack
 * conversation sends its answers back to that chat unless told otherwise.
 */
export function cronTools(scheduler: Scheduler, originOf: (sessionId: string) => ScheduleDelivery | null): ToolDef[] {
  return [
    {
      name: "cronjob_list",
      description:
        "Liste les tâches planifiées (identifiant, fréquence, prochaine exécution, livraison, dernier résultat).",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      async run() {
        const list = scheduler.list();
        const clock = `Heure actuelle : ${new Date().toLocaleString("fr-FR")} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
        return `${clock}\n${list.length ? list.map(describeSchedule).join("\n") : "Aucune tâche planifiée."}`;
      },
    },
    {
      name: "cronjob",
      description:
        "Crée ou gère une tâche planifiée : une consigne que tu exécuteras seul, avec tes outils, à l'heure dite. Traduis la demande de l'utilisateur en `cron` (5 champs, heure locale : « 0 9 * * 1-5 » = jours ouvrés à 9 h ; @daily, @hourly acceptés), en `every_minutes`, ou en `at` (date ISO locale, exécution unique : rappels ; cronjob_list donne l'heure actuelle). `deliver` : here (renvoyer dans cette messagerie — défaut quand la conversation en vient), none, ou telegram:<id> / discord:<id> / slack:<id> / email:<adresse> / whatsapp:<numéro>. Actions : create, update, pause, resume, delete, run (exécuter maintenant).",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "update", "pause", "resume", "delete", "run"] },
          id: { type: "string", description: "Tâche visée (sauf create) : voir cronjob_list." },
          name: { type: "string" },
          prompt: { type: "string", description: "La consigne complète et autonome qui sera exécutée." },
          cron: { type: "string" },
          every_minutes: { type: "integer" },
          at: { type: "string" },
          deliver: { type: "string" },
        },
        required: ["action"],
      },
      dangerous: true,
      source: "builtin",
      async run(args, ctx) {
        const action = String(args.action);
        const origin = originOf(ctx.sessionId);
        // Refuse AVANT toute écriture : le destinataire d'un envoi automatique est confirmé, pas déduit.
        if (action === "create") {
          const name = str(args.name);
          const prompt = str(args.prompt);
          const spec = specFrom(args);
          if (!name || !prompt || !spec)
            throw new Error("create demande name, prompt et une planification (cron, every_minutes ou at).");
          const deliver = deliveryFrom(args.deliver, origin);
          await confirmDelivery(ctx, name, deliver === undefined ? origin : deliver, origin);
          const s = scheduler.save({ name, prompt, spec, deliver: deliver === undefined ? origin : deliver });
          return `Tâche créée :\n${describeSchedule(s)}`;
        }
        const id = str(args.id);
        const current = id ? scheduler.get(id) : undefined;
        if (!current) throw new Error(`Tâche introuvable : ${String(args.id)} (voir cronjob_list).`);
        const base = {
          id: current.id,
          name: current.name,
          prompt: current.prompt,
          spec: current.spec,
          enabled: current.enabled,
        };
        switch (action) {
          case "update": {
            const spec = specFrom(args);
            const deliver = deliveryFrom(args.deliver, origin);
            if (deliver !== undefined) await confirmDelivery(ctx, str(args.name) ?? current.name, deliver, origin);
            const s = scheduler.save({
              ...base,
              ...(str(args.name) ? { name: str(args.name)! } : {}),
              ...(str(args.prompt) ? { prompt: str(args.prompt)! } : {}),
              ...(spec ? { spec, enabled: true } : {}),
              ...(deliver !== undefined ? { deliver } : {}),
            });
            return `Tâche mise à jour :\n${describeSchedule(s)}`;
          }
          case "pause":
            return `Tâche en pause :\n${describeSchedule(scheduler.save({ ...base, enabled: false }))}`;
          case "resume":
            return `Tâche réactivée :\n${describeSchedule(scheduler.save({ ...base, enabled: true }))}`;
          case "delete":
            scheduler.delete(current.id);
            return `Tâche supprimée : ${current.name}`;
          case "run":
            // Not awaited: the run is a whole agent turn in its own conversation.
            void scheduler.runNow(current.id);
            return `Exécution de « ${current.name} » lancée ; le résultat arrivera dans sa conversation${current.deliver ? ` et sur ${current.deliver.gateway}` : ""}.`;
          default:
            throw new Error(`Action inconnue : ${action}`);
        }
      },
    },
  ];
}
