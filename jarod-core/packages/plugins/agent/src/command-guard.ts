/**
 * Garde des commandes `/` reçues d'un canal DISTANT (passerelles de messagerie) — Q19-2.
 *
 * Au composer, l'utilisateur est le principal : il tape `/build`, c'est lui qui décide. Depuis une
 * passerelle, l'auteur est quelqu'un d'autre (chat autorisé, mais distant) : une commande qui change
 * quelque chose est une action comme un outil dangereux. Elle suit donc la même chaîne :
 * règle de configuration (`command/<nom>`, ou `command` pour toutes) → accord si la commande a un
 * effet (ou si la règle dit `ask`) → audit. Les accords d'arrière-plan sont refusés d'office : sans
 * accord possible, une commande à effet est refusée.
 *
 * `autoApproveTools` ne s'applique PAS ici : il règle l'accord des OUTILS de l'agent ; lever le mode
 * Plan ou déplacer le dossier de travail depuis un canal distant ne se règle pas par lui.
 */
import type { ToolGate } from "@jarod/plugin-permissions";
import type { ToolCall } from "@jarod/contracts";
import { newId, truncate } from "@jarod/kernel/util";
import { awaitApproval, type AuditEntry } from "./agent.js";
import { type CommandContext, type CommandRegistry, type CommandResult, isReadOnlyCommand, parseCommand } from "./commands.js";

/** Le nom sous lequel le garde et l'audit voient une commande (`_` et `/` sont équivalents pour les règles). */
export const commandGateName = (name: string): string => `command/${name}`;

export async function executeGuardedCommand(
  commands: CommandRegistry,
  input: string,
  ctx: CommandContext,
  hooks: { approve(sessionId: string, call: ToolCall, description: string): Promise<boolean> },
  extra: { audit?: (entry: AuditEntry) => void; gate?: ToolGate } = {},
  // R3.5 — pas de contrôleur fabriqué ici : sans signal d'appelant, l'échéance d'`awaitApproval` est
  // la borne (la commande distante n'a jamais eu de signal, elle n'en fait plus semblant).
  signal?: AbortSignal,
): Promise<CommandResult | null> {
  const parsed = parseCommand(input);
  if (!parsed) return null;
  const cmd = commands.get(parsed.name);
  // Commande inconnue : aucun effet possible, le message d'aide habituel.
  if (!cmd) return commands.execute(input, ctx);

  const name = commandGateName(parsed.name);
  const sessionId = ctx.sessionId ?? "";
  const audit = (decision: AuditEntry["decision"], ok?: boolean) =>
    extra.audit?.({
      sessionId,
      tool: name,
      args: truncate(JSON.stringify({ args: parsed.args }), 500),
      decision,
      ...(ok === undefined ? {} : { ok }),
    });

  const verdict = extra.gate?.decide(name) ?? "deny";
  if (verdict === "deny") {
    audit("refusé (règle)");
    return { text: `Refusé par la politique de permissions : /${parsed.name}` };
  }

  const effect = !isReadOnlyCommand(cmd, parsed.args);
  let decision: AuditEntry["decision"] | null = null;
  if (effect || verdict === "ask") {
    const call: ToolCall = { id: newId(), name, args: { args: parsed.args } };
    const ok = await awaitApproval(hooks.approve(sessionId, call, cmd.description), signal);
    if (!ok) {
      audit("refusé");
      return {
        text: `/${parsed.name} change quelque chose et demande un accord : impossible depuis une passerelle. À faire dans l'application.`,
      };
    }
    decision = "accordé";
  }
  const result = await commands.execute(input, ctx);
  if (decision) audit(decision, true);
  return result;
}
