// H1 : ce que l'interface montre d'un sous-agent (`subagent.spawn_requested/start/complete`, charge utile `SubagentEventPayload` du contrat).
import type { ToolContext } from "@jarod/plugin-tools";
import type { SubagentObservation, SubagentObserver } from "./subagents.js";

/** Le résumé d'une fin est court : l'interface le montre en une ligne, le compte rendu complet reste dans le résultat de l'outil. */
const SUMMARY_MAX = 240;

const STATUS = { running: "running", done: "completed", failed: "failed", cancelled: "interrupted" } as const;

export function subagentPayload(o: SubagentObservation): Record<string, unknown> {
  const { run } = o;
  const payload: Record<string, unknown> = {
    goal: run.task,
    task_count: 1,
    task_index: 0,
    subagent_id: run.id,
    status: STATUS[run.status],
  };
  if (o.phase === "complete") {
    if (run.endedAt !== null) payload.duration_seconds = Math.max(0, (run.endedAt - run.startedAt) / 1000);
    if (o.answer) payload.summary = o.answer.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
    else if (run.error) payload.summary = run.error.slice(0, SUMMARY_MAX);
  }
  return payload;
}

/**
 * L'observateur à passer à `SubagentsService` : il dit à l'interface que l'enfant est demandé, puis parti, puis fini.
 * `undefined` quand l'appelant n'a pas d'écouteur (tâche planifiée, sous-agent) : rien à relayer.
 */
export function subagentObserver(ctx: Pick<ToolContext, "notify">): SubagentObserver | undefined {
  const notify = ctx.notify;
  if (!notify) return undefined;
  return (o) => {
    if (o.phase === "start") notify("subagent.spawn_requested", subagentPayload({ ...o, phase: "start" }));
    notify(o.phase === "start" ? "subagent.start" : "subagent.complete", subagentPayload(o));
  };
}
