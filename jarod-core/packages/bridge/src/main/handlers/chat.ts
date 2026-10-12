/**
 * Chat en flux : `send-message` / `abort-chat` / `transcribe-audio` de la surface hermesAPI, servis par
 * le runtime d'agent (plugin-agent) au lieu du backend Hermes.
 * Sources : SANK-UI `src/main/ipc/register.ts:1562-1749` (runId stable par conversation, événements
 * `(runId, charge)`, relance du même runId = abandon du précédent, erreur = `chat-error` + rejet, SANS
 * `chat-done`) et `src/shared/chat-stream.ts:1-10` (`ChatToolEvent`), `src/main/hermes.ts:1069-1092`
 * (usage) — rév. 3aaadb0, MIT © github.com/fathah. Côté Jarod : `Jarod-one/packages/desktop/src/main/
 * handlers/index.ts:69-76,183-193` (`submit`, `transcribe`, `stop` ; rév. 2e180305).
 *
 * Écarts assumés (consignés DECISIONS) :
 * - `history` ignoré : Jarod garde la conversation en base (`resumeSessionId` suffit) ;
 * - pièces jointes Hermes refusées (formes différentes) — jamais ignorées en silence ;
 * - `modelOverride` → contexte de la conversation (fournisseur + modèle), sa `baseUrl` n'est pas reprise ;
 *   sans lui (ou incomplet), la conversation suit le modèle ACTIF (`set-model-config`) : Hermes relit
 *   `config.yaml` à chaque message, et l'écran renvoie le choix « cette conversation seulement » à chaque envoi ;
 *   SAUF si elle est épinglée (`set-session-model-override`, Q10) : elle garde alors son modèle ;
 * - approbations d'outils : le crochet `approve` passe par le courtier d'accord (`approvals.ts`) — la fenêtre affiche la demande,
 *   l'utilisateur répond ; arrêt du tour, fin du tour ou délai = refus (fail-closed).
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentHooks } from "@jarod/plugin-agent";
import type { FileGate } from "../file-gate.js";
import type { ApprovalBroker } from "./approvals.js";
import { assertProfile, type HandlerContext } from "./context.js";

/** `ChatToolEvent` (SANK-UI `shared/chat-stream.ts:1-10`). */
export interface ChatToolEvent {
  callId: string;
  hasStableCallId?: boolean;
  name: string;
  status: "running" | "completed" | "failed";
  label?: string;
  result?: string;
}

const RESULT_PREVIEW = 2000;

export function createChatHandlers(ctx: HandlerContext, gate: FileGate, approvals: ApprovalBroker) {
  const agent = () => ctx.kernel().agent;
  /** runId → conversation : `abort-chat(runId)` arrête ce tour-là, pas les autres. */
  const runs = new Map<string, string>();
  /** runId → jeton du tour en cours (les demandes d'accord de ce tour, et d'aucun autre). */
  const owners = new Map<string, string>();

  return {
    // register.ts:1752-1759 + hermes.ts:1054-1063 : répond à une question `clarify` en attente. L'agent Jarod n'a pas
    // d'outil `clarify` : aucune demande ne peut être en attente → false, la réponse SANK-UI pour un id inconnu.
    "clarify-respond": (): false => false,
    "send-message": (
      message: unknown,
      profile?: unknown,
      resumeSessionId?: unknown,
      _history?: unknown,
      attachments?: unknown,
      contextFolder?: unknown,
      runId?: unknown,
      modelOverride?: unknown,
    ): Promise<{ response: string; sessionId?: string }> => {
      assertProfile(ctx, profile);
      if (typeof message !== "string") throw new Error("[oneai] send-message : message invalide");
      if (Array.isArray(attachments) && attachments.length > 0) {
        throw new Error("[oneai] send-message : pièces jointes Hermes non portées");
      }
      const a = agent();
      // Q12 : le dossier lié devient une racine de la garde fichiers — même règle que `set-session-context-folder`
      // (jugé AVANT de créer la conversation : un refus ne laisse pas de conversation vide).
      const workspace = typeof contextFolder === "string" && contextFolder ? gate.bindable("send-message", contextFolder) : null;
      const chatRunId = typeof runId === "string" && runId ? runId : `run-${randomUUID()}`;
      const prior = runs.get(chatRunId);
      if (prior) {
        a.stop(prior);
        const old = owners.get(chatRunId);
        if (old) approvals.cancel(old);
      }
      const owner = randomUUID();
      owners.set(chatRunId, owner);

      let sessionId: string;
      if (typeof resumeSessionId === "string" && resumeSessionId) {
        if (!a.sessions.get(resumeSessionId)) throw new Error(`[oneai] conversation inconnue : ${resumeSessionId}`);
        sessionId = resumeSessionId;
      } else {
        sessionId = a.sessions.create().id;
      }
      if (workspace) a.updateSessionContext(sessionId, { workspace });
      const o = modelOverride && typeof modelOverride === "object" ? (modelOverride as { provider?: unknown; model?: unknown }) : {};
      if (typeof o.provider === "string" && typeof o.model === "string") {
        a.updateSessionContext(sessionId, { provider: o.provider, model: o.model });
      } else if (!a.sessions.get(sessionId)?.context?.modelPinned) {
        // Q10 : seule une conversation NON épinglée suit le modèle actif ; épinglée, elle garde le sien.
        a.updateSessionContext(sessionId, { provider: a.settings.get("activeProvider"), model: a.settings.get("activeModel") });
      }

      const send = (channel: string, payload: unknown) => ctx.shell.send(channel, chatRunId, payload);
      send("chat-session-started", sessionId);
      runs.set(chatRunId, sessionId);

      return new Promise((resolve, reject) => {
        let full = "";
        let error: string | undefined;
        const finish = () => {
          approvals.cancel(owner);
          if (owners.get(chatRunId) === owner) owners.delete(chatRunId);
          if (runs.get(chatRunId) === sessionId) runs.delete(chatRunId);
        };
        const hooks: AgentHooks = {
          // La fenêtre demande à l'utilisateur ; sans réponse (arrêt, fin de tour, délai) : refus.
          approve: (sid, call, description) => approvals.request(owner, chatRunId, sid, call, description),
          emit: (e: AgentEvent) => {
            switch (e.type) {
              case "delta":
                if (e.text) {
                  full += e.text;
                  send("chat-chunk", e.text);
                }
                if (e.thinking) send("chat-reasoning-chunk", e.thinking);
                return;
              case "stream-reset":
                full = "";
                return;
              case "tool-start":
                send("chat-tool-event", {
                  callId: e.call.id,
                  hasStableCallId: true,
                  name: e.call.name,
                  status: "running",
                  label: e.call.name,
                } satisfies ChatToolEvent);
                return;
              case "message": {
                const m = e.message;
                if (m.role === "tool") {
                  send("chat-tool-event", {
                    callId: m.toolCallId ?? "",
                    hasStableCallId: !!m.toolCallId,
                    name: m.toolName ?? "tool",
                    status: m.isError ? "failed" : "completed",
                    label: m.toolName ?? "tool",
                    ...(m.content ? { result: m.content.slice(0, RESULT_PREVIEW) } : {}),
                  } satisfies ChatToolEvent);
                } else if (m.role === "assistant" && (m.inputTokens != null || m.outputTokens != null)) {
                  const promptTokens = m.inputTokens ?? 0;
                  const completionTokens = m.outputTokens ?? 0;
                  send("chat-usage", {
                    promptTokens,
                    completionTokens,
                    totalTokens: promptTokens + completionTokens,
                    ...(m.cacheReadTokens ? { cacheReadTokens: m.cacheReadTokens } : {}),
                    ...(m.cacheWriteTokens ? { cacheWriteTokens: m.cacheWriteTokens } : {}),
                  });
                }
                return;
              }
              case "error":
                error = e.error;
                send("chat-error", e.error);
                return;
              case "done": {
                finish();
                if (error !== undefined) {
                  reject(new Error(error));
                  return;
                }
                const last = [...agent().messages.list(sessionId)].reverse().find((m) => m.role === "assistant");
                send("chat-done", sessionId);
                resolve({ response: last?.content || full, sessionId });
                return;
              }
              default:
                return;
            }
          },
        };
        a.submit(sessionId, message, hooks).then(
          (r) => {
            if (r.kind === "busy") {
              finish();
              const msg = "Une réponse est déjà en cours dans cette conversation.";
              send("chat-error", msg);
              reject(new Error(msg));
            } else if (r.kind === "command") {
              // Commande intégrée (`/persona`, `/pair`…) : sa réponse locale tient lieu de message.
              finish();
              const text = r.result.text ?? "";
              if (text) send("chat-chunk", text);
              send("chat-done", sessionId);
              resolve({ response: text, sessionId });
            }
          },
          (e: unknown) => {
            finish();
            const msg = (e as Error).message;
            send("chat-error", msg);
            reject(e as Error);
          },
        );
      });
    },

    "abort-chat": (runId?: unknown) => {
      if (typeof runId === "string" && runId) {
        const sessionId = runs.get(runId);
        if (sessionId) agent().stop(sessionId);
        runs.delete(runId);
        const owner = owners.get(runId);
        if (owner) approvals.cancel(owner);
        owners.delete(runId);
        return;
      }
      for (const sessionId of runs.values()) agent().stop(sessionId);
      runs.clear();
      for (const owner of owners.values()) approvals.cancel(owner);
      owners.clear();
    },

    "transcribe-audio": async (audio: unknown, mimeType: unknown, profile?: unknown): Promise<string> => {
      assertProfile(ctx, profile);
      if (!(audio instanceof Uint8Array) || typeof mimeType !== "string") throw new Error("[oneai] transcribe-audio : audio invalide");
      return ctx.kernel().gateways.transcribe(Buffer.from(audio), mimeType);
    },
  };
}
