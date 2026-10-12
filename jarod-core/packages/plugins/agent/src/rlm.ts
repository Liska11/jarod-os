/**
 * Jarod-cordis (Q18, décision utilisateur 2026-09-28) : sous-agents NON BLOQUANTS — pattern « Subagents are
 * native RLM calls » de Prime Agent, portage de SANK-AI `src/core/runtime/plugins/rlm-subagent/index.js`
 * (MIT © SankAi contributors) : le lancement rend un identifiant tout de suite, le résultat se lit ensuite.
 *
 * Écarts assumés : l'enfant a les garanties de `delegate_task` (lecture seule, contexte séparé, borne de
 * `SubagentsService`, journal, annulation) — il n'hérite JAMAIS des outils d'écriture du parent ; son
 * résultat est sa réponse finale (pas d'`agent_message` enfant → parent) ; registre en mémoire, limité à la
 * conversation qui l'a lancé (un enfant ne survit pas à un redémarrage, et `subagent_result` le dit).
 */
import type { ToolDef } from "@jarod/plugin-tools";
import type { SubagentsService } from "./subagents.js";

type Work = (task: string, signal: AbortSignal, sessionId: string) => Promise<string>;

interface Child {
  id: string;
  name: string;
  sessionId: string;
  result?: string;
}

export class RlmChildren {
  private readonly children = new Map<string, Child>();
  private seq = 0;

  constructor(
    private readonly subagents: SubagentsService,
    private readonly work: Work,
  ) {}

  /** Lance l'enfant et rend la main. Au-delà de la borne : refus lisible (`SUBAGENT_LIMIT`), comme `delegate_task`. */
  spawn(sessionId: string, task: string, name?: string): Child {
    const { id, result } = this.subagents.start(task, sessionId, (t, signal) => this.work(t, signal, sessionId));
    const child: Child = { id, name: name?.trim() || `enfant-${++this.seq}`, sessionId };
    this.children.set(id, child);
    result.then(
      (answer) => {
        child.result = answer;
      },
      () => {
        /* l'état et l'erreur sont dans le journal de SubagentsService */
      },
    );
    this.prune();
    return child;
  }

  /** Les enfants de CETTE conversation, avec leur état au journal. */
  of(sessionId: string) {
    return [...this.children.values()]
      .filter((c) => c.sessionId === sessionId)
      .map((c) => {
        const run = this.subagents.get(c.id);
        return { id: c.id, name: c.name, status: run?.status ?? "inconnu", run, result: c.result };
      });
  }

  find(sessionId: string, ref: string) {
    const r = ref.trim();
    return this.of(sessionId).find((c) => c.id === r || c.name === r);
  }

  /** Le journal de SubagentsService est borné : un enfant qui en est sorti est oublié ici aussi. */
  private prune(): void {
    for (const id of this.children.keys()) if (!this.subagents.get(id)) this.children.delete(id);
  }
}

export function rlmTools(rlm: RlmChildren, subagents: SubagentsService): ToolDef[] {
  const unknown = (ref: string) =>
    `Aucun sous-agent « ${ref} » dans cette conversation (un sous-agent ne survit pas à un redémarrage de Jarod).`;
  return [
    {
      name: "spawn_subagent",
      description:
        "Lance un sous-agent en ARRIÈRE-PLAN sur une tâche de recherche ou d'analyse autonome (outils en lecture seule, contexte séparé) et rend tout de suite son identifiant, sans attendre. Lis son résultat plus tard avec subagent_result. Pour plusieurs explorations en parallèle ; si tu as besoin du résultat pour continuer, utilise plutôt delegate_task.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "La tâche, complète et autonome (le sous-agent ne voit pas la conversation)" },
          name: { type: "string", description: "Nom lisible (défaut : enfant-N)" },
        },
        required: ["task"],
      },
      source: "builtin",
      async run(args, ctx) {
        const c = rlm.spawn(ctx.sessionId, String(args.task ?? ""), typeof args.name === "string" ? args.name : undefined);
        return JSON.stringify({ id: c.id, name: c.name, status: "lancé" });
      },
    },
    {
      name: "subagent_result",
      description: "État d'un sous-agent lancé par spawn_subagent (id ou nom) et, s'il a fini, son compte rendu.",
      parameters: { type: "object", properties: { id: { type: "string", description: "Identifiant ou nom" } }, required: ["id"] },
      source: "builtin",
      async run(args, ctx) {
        const ref = String(args.id ?? "");
        const c = rlm.find(ctx.sessionId, ref);
        if (!c) return unknown(ref);
        if (c.status === "running") return `${c.name} (${c.id}) : en cours.`;
        if (c.status === "done") return `${c.name} (${c.id}) : terminé.\n\n${c.result ?? ""}`;
        if (c.status === "cancelled") return `${c.name} (${c.id}) : annulé.`;
        return `${c.name} (${c.id}) : échec — ${c.run?.error ?? "erreur inconnue"}`;
      },
    },
    {
      name: "subagent_list",
      description: "Liste les sous-agents lancés dans cette conversation (spawn_subagent) et leur état.",
      parameters: { type: "object", properties: {} },
      source: "builtin",
      async run(_args, ctx) {
        return JSON.stringify(
          rlm.of(ctx.sessionId).map((c) => ({ id: c.id, name: c.name, status: c.status, task: c.run?.task ?? "" })),
        );
      },
    },
    {
      name: "subagent_cancel",
      description: "Arrête un sous-agent en cours lancé dans cette conversation (id ou nom).",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      source: "builtin",
      async run(args, ctx) {
        const ref = String(args.id ?? "");
        const c = rlm.find(ctx.sessionId, ref);
        if (!c) return unknown(ref);
        return subagents.cancel(c.id) ? `${c.name} : arrêt demandé.` : `${c.name} n'est plus en cours (${c.status}).`;
      },
    },
  ];
}
