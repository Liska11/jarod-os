// SPECS-P5-ACP.md §3 (autorisations) : `hooks.approve` de l'agent → `session/request_permission` de l'éditeur. FAIL-CLOSED :
// toute issue autre qu'un « oui » explicite sur une option d'autorisation PROPOSÉE vaut refus. Délai : 300 s (décision Q2 du 2026-10-02).
import type { ToolCall } from "@jarod/contracts";
import { redactText } from "@jarod/kernel/redact";
import { redactArgs, toolCallStart, toolKindOf, toolTitle } from "./acp-events.js";

/** Q2 (approuvé) : au-delà de 300 s sans réponse de l'éditeur, l'outil est REFUSÉ. */
export const PERMISSION_TIMEOUT_MS = 300_000;

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "reject_once";
}

/** Q3 (recommandé, en attente de décision) : jamais d'option « toujours » ni « pour la session » — l'éditeur ne peut pas élargir la porte. */
export const DEFAULT_PERMISSION_OPTIONS: readonly AcpPermissionOption[] = [
  { optionId: "allow_once", name: "Autoriser cette fois", kind: "allow_once" },
  { optionId: "reject_once", name: "Refuser", kind: "reject_once" },
];

export type PermissionVerdict = "allowed" | "denied" | "timeout" | "cancelled" | "error";

export interface AskPermissionOptions {
  /** `session/request_permission` côté éditeur (le transport JSON-RPC). */
  request(params: unknown): Promise<unknown>;
  sessionId: string;
  call: ToolCall;
  description: string;
  timeoutMs?: number;
  options?: readonly AcpPermissionOption[];
  /** Annulation de la session (`session/cancel`) : refus immédiat. */
  signal?: AbortSignal;
}

/** Interprète la réponse de l'éditeur ; tout ce qui n'est pas « sélectionné parmi les options autorisantes proposées » est un refus. */
export function verdictOfResponse(response: unknown, options: readonly AcpPermissionOption[]): PermissionVerdict {
  const outcome = (response as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)?.outcome;
  if (!outcome || typeof outcome !== "object") return "denied";
  if (outcome.outcome === "cancelled") return "cancelled";
  if (outcome.outcome !== "selected" || typeof outcome.optionId !== "string") return "denied";
  const chosen = options.find((o) => o.optionId === outcome.optionId);
  return chosen?.kind === "allow_once" ? "allowed" : "denied";
}

export async function askPermission(o: AskPermissionOptions): Promise<{ allowed: boolean; verdict: PermissionVerdict }> {
  const options = o.options ?? DEFAULT_PERMISSION_OPTIONS;
  const timeoutMs = o.timeoutMs ?? PERMISSION_TIMEOUT_MS;
  if (o.signal?.aborted) return { allowed: false, verdict: "cancelled" };
  const start = toolCallStart(o.call);
  const params = {
    sessionId: o.sessionId,
    toolCall: {
      toolCallId: start.toolCallId,
      title: toolTitle(o.call),
      kind: toolKindOf(o.call.name),
      status: "pending" as const,
      rawInput: redactArgs(o.call.args),
      content: o.description ? [{ type: "content" as const, content: { type: "text" as const, text: redactText(o.description) } }] : [],
    },
    options: options.map((x) => ({ optionId: x.optionId, name: x.name, kind: x.kind })),
  };

  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const verdict = await new Promise<PermissionVerdict>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    if (o.signal) {
      onAbort = () => resolve("cancelled");
      o.signal.addEventListener("abort", onAbort, { once: true });
    }
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(o.request(params));
    } catch {
      return resolve("error");
    }
    pending.then(
      (r) => resolve(verdictOfResponse(r, options)),
      () => resolve("error"),
    );
  }).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) o.signal?.removeEventListener("abort", onAbort);
  });
  return { allowed: verdict === "allowed", verdict };
}
