// Passerelle compatible Hermes (essai) : la traduction PURE entre le noyau de Jarod et le protocole que parle le shell de Herald OS
// (JSON-RPC 2.0 sur WebSocket, contrat `tui_gateway`). Aucune entrée-sortie ici : tout est testable seul.
// Formes vérifiées contre `gateway-contract.generated.ts` (Herald OS, `upstream/hermes-agent/apps/shared/src`) ; ce qui n'y est pas
// exigé (champs optionnels) est omis plutôt qu'inventé.
import { posix, win32 } from "node:path";
import type { Message, Session } from "@jarod/contracts";
import type { AgentEvent } from "@jarod/plugin-agent";

/** Une notification `event` du serveur vers le shell. */
export interface GatewayEventFrame {
  jsonrpc: "2.0";
  method: "event";
  params: { type: string; session_id?: string; payload?: unknown };
}

export const eventFrame = (type: string, sessionId?: string, payload?: unknown): GatewayEventFrame => ({
  jsonrpc: "2.0",
  method: "event",
  params: { type, ...(sessionId ? { session_id: sessionId } : {}), ...(payload === undefined ? {} : { payload }) },
});

/** `gateway.ready` : la première trame de toute connexion (`GatewayReadyPayload`). Pas de rejeu d'événements, pas de battement. */
export function readyFrame(replayEpoch: string): GatewayEventFrame {
  return eventFrame("gateway.ready", undefined, { skin: { name: "jarod" }, change_events: false, replay_epoch: replayEpoch, heartbeat: false });
}

const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Traduit les événements d'UN tour de l'agent de Jarod en événements du shell. Un traducteur par tour.
 *
 * Correspondances (AgentEvent → GatewayEvent) :
 *   stream-start → message.start      delta.text → message.delta      delta.thinking → reasoning.delta
 *   tool-start → tool.start           message(role tool) → tool.complete    status → status.update
 *   error → error                     done → message.complete (status complete | interrupted | error)
 * Sans équivalent (ignorés, comptés) : stream-reset, history, session-updated.
 */
export class TurnTranslator {
  private streamed = false;
  private finalText = "";
  private errorText: string | undefined;
  private aborted = false;
  /** Les types d'événements Jarod qu'on n'a pas su traduire : la mesure de ce qui manque. */
  readonly ignored = new Map<string, number>();

  constructor(
    private readonly sessionId: string,
    private readonly out: (frame: GatewayEventFrame) => void,
  ) {}

  private emit(type: string, payload?: unknown): void {
    this.out(eventFrame(type, this.sessionId, payload));
  }

  markAborted(): void {
    this.aborted = true;
  }

  handle(e: AgentEvent): void {
    switch (e.type) {
      case "stream-start":
        this.streamed = false;
        this.emit("message.start", {});
        return;
      case "delta":
        if (e.text) {
          this.streamed = true;
          this.finalText += e.text;
          this.emit("message.delta", { text: e.text });
        }
        if (e.thinking) this.emit("reasoning.delta", { text: e.thinking });
        return;
      case "tool-start":
        this.emit("tool.start", { tool_id: e.call.id, name: e.call.name, args: e.call.args });
        return;
      case "message": {
        const m = e.message;
        if (m.role === "tool") {
          this.emit("tool.complete", {
            tool_id: m.toolCallId ?? m.id,
            name: m.toolName ?? "tool",
            result: m.content,
            result_text: m.content,
            summary: m.isError ? `Erreur : ${clip(m.content, 120)}` : clip(m.content.replace(/\s+/g, " "), 120),
          });
        } else if (m.role === "assistant") {
          if (!this.streamed && m.content) {
            // Un fournisseur sans flux : le texte arrive d'un bloc, le shell l'attend en deltas.
            this.emit("message.start", {});
            this.emit("message.delta", { text: m.content });
          }
          this.finalText = m.content || this.finalText;
        }
        return;
      }
      case "status":
        this.emit("status.update", { kind: "status", text: e.status });
        return;
      case "error":
        this.errorText = e.error;
        this.emit("error", { message: e.error });
        return;
      case "done":
        this.emit("message.complete", {
          text: this.finalText,
          status: this.errorText ? "error" : this.aborted ? "interrupted" : "complete",
          ...(this.errorText ? { error: this.errorText } : {}),
        });
        return;
      default:
        this.ignored.set(e.type, (this.ignored.get(e.type) ?? 0) + 1);
    }
  }
}

/** Le texte d'un `prompt.submit` : une chaîne, ou une liste de parties `{type:"text", text}` (le contrat dit `unknown`). */
export function promptText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => (typeof part === "string" ? part : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * L'historique d'une conversation au format de transcription du shell (`TranscriptMessage`). Un message d'assistant qui ne porte que des appels d'outil
 * n'a pas de texte : il n'est pas rendu comme une bulle vide, ses appels apparaissent par leurs lignes d'outil (avec les arguments de l'appel).
 */
export function toTranscript(messages: readonly Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const args = new Map<string, Record<string, unknown>>();
  for (const m of messages) for (const c of m.toolCalls ?? []) args.set(c.id, c.args);
  for (const m of messages) {
    if (m.compacted) continue;
    const timestamp = Math.floor(m.createdAt / 1000);
    if (m.role === "user") out.push({ role: "user", text: m.content, timestamp });
    else if (m.role === "assistant") {
      if (!m.content.trim() && !m.thinking) continue;
      out.push({ role: "assistant", text: m.content, timestamp, ...(m.thinking ? { reasoning: m.thinking } : {}) });
    } else {
      const id = m.toolCallId ?? m.id;
      const a = args.get(id);
      out.push({ role: "tool", text: m.content, tool_call_id: id, name: m.toolName ?? "tool", timestamp, ...(a ? { args: a } : {}) });
    }
  }
  return out;
}

/**
 * Les messages d'une conversation tels que `GET /api/sessions/{id}/messages` les rend (le panneau « Catch-up » lit où une conversation s'est arrêtée) :
 * `content` en texte, `timestamp` en secondes. `latest` : les `limit` derniers, dans l'ordre chronologique ; sinon les `limit` premiers.
 */
export function storedMessages(messages: readonly Message[], opts: { limit?: number; order?: string } = {}): { messages: { role: string; content: string; timestamp: number }[] } {
  const rows = messages
    .filter((m) => !m.compacted)
    .map((m) => ({ role: m.role === "user" || m.role === "assistant" ? m.role : "tool", content: m.content, timestamp: Math.floor(m.createdAt / 1000) }));
  const limit = Number.isInteger(opts.limit) && (opts.limit as number) > 0 ? Math.min(opts.limit as number, 500) : 100;
  return { messages: opts.order === "latest" ? rows.slice(-limit) : rows.slice(0, limit) };
}

export interface SessionInfoInput {
  session: Session;
  running: boolean;
  version: string;
  provider?: string;
  model?: string;
  cwd?: string | null;
}

/** `SessionLiveInfo` : ce que le shell affiche de la session (modèle, dossier, état). */
export function sessionInfo(i: SessionInfoInput): Record<string, unknown> {
  return {
    title: i.session.title,
    stored_session_id: i.session.id,
    running: i.running,
    version: i.version,
    approval_mode: "manual",
    ...(i.provider ? { provider: i.provider } : {}),
    ...(i.model ? { model: i.model } : {}),
    ...(i.cwd ? { cwd: i.cwd } : {}),
    tools: {},
    skills: {},
  };
}

/** Une ligne de `session.list` (`SessionListRow`) ; les dates du contrat sont en secondes. */
export function sessionRow(s: Session, preview = ""): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    preview,
    started_at: Math.floor(s.createdAt / 1000),
    message_count: s.messageCount,
    source: "desktop", // le shell de Herald ne liste que ses propres surfaces (herald_os, desktop, cli, tui) : une valeur inconnue rendait l'historique vide
  };
}

export type ApprovalChoice = "once" | "session" | "always" | "deny";

/** La demande d'accord envoyée au shell (`ApprovalRequestParams`). « Toujours » n'est jamais offert : la politique de Jarod le refuse pour ses outils sensibles. */
export function approvalParams(sessionId: string, requestId: string, call: { name: string; args: Record<string, unknown> }, description: string): Record<string, unknown> {
  const args = JSON.stringify(call.args);
  return {
    session_id: sessionId,
    request_id: requestId,
    command: `${call.name} ${clip(args, 400)}`,
    description,
    choices: ["once", "deny"] satisfies ApprovalChoice[],
    allow_permanent: false,
    allow_session: false,
    tool_name: call.name,
  };
}

/**
 * La réponse du shell à une demande d'accord. `once`, `session` et `always` accordent CET appel et rien de plus (aucun accord ne
 * persiste ici : le garde de Jarod reste le seul à retenir un « Toujours ») ; `deny`, une réponse absente ou illisible refusent.
 */
export function isApproved(result: unknown): boolean {
  const choice = result && typeof result === "object" ? (result as { choice?: unknown }).choice : undefined;
  return choice === "once" || choice === "session" || choice === "always";
}

/**
 * Le dossier de travail d'une nouvelle conversation. Herald envoie SON dossier courant (ici le dossier personnel) : sans réglage, on le
 * suit (comportement de l'essai). Avec un dossier de base, celui-ci l'emporte, et un dossier demandé n'est accepté que s'il est DEDANS
 * (un sous-dossier choisi dans le shell) ; tout autre — le dossier personnel, un lecteur entier, un chemin relatif — retombe sur la base.
 */
export function chooseWorkspace(requested: string, base: string | undefined, win = process.platform === "win32"): string | undefined {
  if (!base) return requested || undefined;
  if (!requested) return base;
  const norm = (p: string) => {
    const r = win ? win32.resolve(p) : posix.resolve(p);
    return win ? r.toLowerCase() : r;
  };
  const p = win ? win32 : posix;
  // Un chemin relatif serait résolu contre le dossier du processus : on ne le prend pas pour un choix de l'utilisateur.
  if (!p.isAbsolute(requested)) return base;
  const rel = p.relative(norm(base), norm(requested));
  const outside = rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel);
  return outside ? base : requested;
}

/** Erreurs JSON-RPC standard. */
export const RPC = { parse: -32700, invalid: -32600, notFound: -32601, params: -32602, internal: -32603 } as const;
