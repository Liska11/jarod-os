/**
 * Conversations, sur `agent.sessions` / `agent.messages` (plugin-agent) aux formes de la surface
 * hermesAPI. Sources des formes : SANK-UI `src/main/sessions.ts:56-96` (`HistoryItem`), `:177-185`
 * (`SearchResult`), `:263-302` (`listSessions`), `:555-627` (`expandRowsToHistory`), `:703-706`
 * (`DeleteSessionsResult`), `ipc/register.ts:2159-2284,2569-2625` (dont `sync-session-cache` :2584-2600) (rév. 3aaadb0, MIT © github.com/fathah).
 * Handlers Jarod : `Jarod-one/packages/desktop/src/main/handlers/session.ts:7-17` + `handlers/index.ts:168-173`
 * (rév. 2e180305 : on arrête le tour en cours avant de supprimer).
 *
 * Écarts assumés : horodatages en SECONDES (Hermes `state.db`), identifiants de message = rang dans la
 * conversation (Hermes : entier auto-incrémenté ; Jarod : chaîne) ; `source` = passerelle qui a ouvert la
 * conversation (`gateway_chats`), sinon « desktop » ; pièces jointes non relayées (formes différentes).
 */
import type { Message, Session } from "@jarod/contracts";
import type { FileGate } from "../file-gate.js";
import { type ContinuationDb, type ContinuationHistoryItem, SessionContinuationStore } from "../session-continuation.js";
import { type HandlerContext, toHermesTime } from "./context.js";
import { clearStaging } from "./files.js";

/** Forme SANK-UI (`sessions.ts:56-96`) ; `error` : erreur locale ré-affichée (Q13-1). */
export type HistoryItem = ContinuationHistoryItem;

/** `expandRowsToHistory` (sessions.ts:555-627) sur les messages Jarod. */
export function toHistory(messages: Message[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  messages.forEach((m, i) => {
    const id = i + 1;
    const timestamp = m.createdAt / 1000;
    if (m.role === "user") {
      if (m.content) items.push({ kind: "user", id, content: m.content, timestamp });
      return;
    }
    if (m.role === "assistant") {
      if (m.thinking) items.push({ kind: "reasoning", id, assistantId: id, text: m.thinking, timestamp });
      if (m.content) items.push({ kind: "assistant", id, content: m.content, timestamp });
      for (const tc of m.toolCalls ?? []) {
        items.push({ kind: "tool_call", id, assistantId: id, callId: tc.id, name: tc.name, args: JSON.stringify(tc.args, null, 2), timestamp });
      }
      return;
    }
    items.push({ kind: "tool_result", id, callId: m.toolCallId ?? "", name: m.toolName ?? "tool", content: m.content, timestamp });
  });
  return items;
}

export function createSessionHandlers(ctx: HandlerContext, gate: FileGate) {
  const agent = () => ctx.kernel().agent;
  const continuations = new SessionContinuationStore(() => agent().db as unknown as ContinuationDb);
  /** Q13-1 : conversation connue exigée (SANK-UI : `true` sans écriture) — jamais de succès apparent. */
  const known = (sessionId: unknown): string => {
    if (typeof sessionId !== "string" || !sessionId || !agent().sessions.get(sessionId)) throw new Error(`[oneai] conversation inconnue : ${String(sessionId)}`);
    return sessionId;
  };
  const source = (id: string) => agent().gatewayChatOf(id)?.gateway ?? "desktop";
  /** Hermes trie par date de début décroissante (sessions.ts:279) ; Jarod par épingle puis activité. */
  const byStart = (): Session[] => agent().sessions.list(Number.MAX_SAFE_INTEGER).sort((a, b) => b.createdAt - a.createdAt);
  const page = (limit: unknown, offset: unknown, dflt: number) => {
    const lim = typeof limit === "number" && limit > 0 ? limit : dflt;
    const off = typeof offset === "number" && offset > 0 ? offset : 0;
    return byStart().slice(off, off + lim);
  };
  const remove = (id: string): boolean => {
    if (!agent().sessions.get(id)) return false;
    agent().stop(id);
    agent().sessions.delete(id);
    // sessions.ts:770 (SANK-UI) : les pièces collées de la conversation partent avec elle ; continuations et
    // erreurs locales : suppression en cascade (migration v16).
    clearStaging(ctx, gate, id);
    return true;
  };

  const cached = (s: Session) => ({
    id: s.id,
    title: s.title,
    startedAt: toHermesTime(s.createdAt),
    source: source(s.id),
    messageCount: s.messageCount,
    model: s.context?.model ?? "",
    contextFolder: s.context?.workspace ?? null,
  });

  return {
    "list-sessions": (limit?: unknown, offset?: unknown) =>
      page(limit, offset, 30).map((s) => ({
        id: s.id,
        source: source(s.id),
        startedAt: toHermesTime(s.createdAt),
        endedAt: null,
        messageCount: s.messageCount,
        model: s.context?.model ?? "",
        title: s.title,
        preview: "",
      })),
    "list-cached-sessions": (limit?: unknown, offset?: unknown) => page(limit, offset, 50).map(cached),
    /**
     * register.ts:2584-2600 : Hermes recopie `state.db` dans son cache puis rend les 50 premières. Jarod lit
     * directement sa base : rien à synchroniser, même liste que `list-cached-sessions` (50).
     */
    "sync-session-cache": () => page(50, 0, 50).map(cached),
    "get-session-messages": (sessionId: unknown) =>
      typeof sessionId === "string" ? continuations.history(sessionId, toHistory(agent().messages.list(sessionId))) : [],
    // register.ts:2194-2200 : début d'une conversation poursuivie, ré-affiché à la réouverture (Q13-1).
    "record-session-continuation": (sessionId: unknown, items: unknown): true => {
      continuations.recordContinuation(known(sessionId), items);
      return true;
    },
    // register.ts:2202-2208 : erreur locale d'un envoi échoué (jamais reçue par le kernel), ré-affichée (Q13-1).
    "record-session-local-error": (sessionId: unknown, error: unknown): true => {
      const e = error && typeof error === "object" ? (error as { error?: unknown; userContent?: unknown }) : {};
      continuations.recordLocalError(known(sessionId), e.error, e.userContent);
      return true;
    },
    "update-session-title": (sessionId: unknown, title: unknown) => {
      if (typeof sessionId !== "string" || typeof title !== "string") throw new Error("[oneai] update-session-title : arguments invalides");
      agent().sessions.rename(sessionId, title);
    },
    "delete-session": (sessionId: unknown) => {
      if (typeof sessionId === "string") remove(sessionId);
    },
    "delete-sessions": (sessionIds: unknown) => {
      const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()))];
      return { requested: ids.length, deleted: ids.filter(remove).length };
    },
    "search-sessions": (query: unknown, limit?: unknown) => {
      if (typeof query !== "string" || !query.trim()) return [];
      const lim = typeof limit === "number" && limit > 0 ? limit : 20;
      return agent()
        .sessions.search(query, lim)
        .map((h) => {
          const s = agent().sessions.get(h.sessionId);
          return {
            sessionId: h.sessionId,
            title: h.title,
            startedAt: toHermesTime(s?.createdAt ?? h.updatedAt),
            source: source(h.sessionId),
            messageCount: s?.messageCount ?? 0,
            model: s?.context?.model ?? "",
            snippet: h.snippet,
          };
        });
    },
    /** Hermes : dossier lié à une conversation ; Jarod : le `workspace` de son contexte. */
    "get-session-context-folder": (sessionId: unknown) =>
      typeof sessionId === "string" ? (agent().sessions.get(sessionId)?.context?.workspace ?? null) : null,
    /**
     * register.ts:2216-2222 (`session-context-folder-store.ts:36-56`) : lie un dossier à la conversation.
     * Jarod : c'est le dossier de travail des outils de CETTE conversation (même règle que `/workspace` :
     * dossier existant, chemin absolu). Délier (null / "") = revenir au dossier de travail par défaut
     * (réglage `workspace`) — l'écran Chat envoie null pour une conversation neuve sans dossier.
     * Q12 : un dossier lié devient une RACINE de la garde fichiers — il doit donc venir de l'utilisateur : choisi
     * dans la boîte native (`select-folder`) pendant ce lancement, ou déjà sous un dossier de travail ; jamais un
     * chemin libre du renderer. Chemin réel enregistré.
     */
    "set-session-context-folder": (sessionId: unknown, folder: unknown): true => {
      if (typeof sessionId !== "string" || !agent().sessions.get(sessionId)) throw new Error(`[oneai] conversation inconnue : ${String(sessionId)}`);
      if (folder === null || folder === undefined || folder === "") {
        agent().updateSessionContext(sessionId, { workspace: agent().settings.get("workspace") });
        return true;
      }
      agent().updateSessionContext(sessionId, { workspace: gate.bindable("set-session-context-folder", folder) });
      return true;
    },
    /**
     * register.ts:2246-2248 (`session-model-override-store.ts:56-75`) : le modèle choisi « pour cette
     * conversation seulement », relu à la réouverture (`Chat.tsx:343-368`). Jarod (Q10) : le contexte de la
     * conversation s'il est ÉPINGLÉ, sinon null (elle suit le modèle actif). `baseUrl` = celle du fournisseur
     * (catalogue ; « » s'il n'y est plus) : Jarod ne garde pas d'URL par conversation.
     */
    "get-session-model-override": (sessionId: unknown): { provider: string; model: string; baseUrl: string } | null => {
      if (typeof sessionId !== "string" || !sessionId) return null;
      const c = agent().sessions.get(sessionId)?.context;
      if (!c?.modelPinned || !c.provider || !c.model) return null;
      let baseUrl = "";
      try {
        baseUrl = agent().providers.def(c.provider).baseUrl;
      } catch {
        /* fournisseur sorti du catalogue */
      }
      return { provider: c.provider, model: c.model, baseUrl };
    },
    /**
     * register.ts:2250-2256 (`session-model-override-store.ts:31-54`) : épingle le modèle de la conversation ;
     * sans modèle (null, `model` vide) = désépingler → elle suit de nouveau le modèle ACTIF (son contexte y
     * revient au prochain envoi). Fournisseur hors catalogue refusé (même règle que `set-model-config`) ;
     * `baseUrl` ignorée : l'URL d'un fournisseur du catalogue ne se redirige pas depuis le renderer.
     */
    "set-session-model-override": (sessionId: unknown, override: unknown): true => {
      if (typeof sessionId !== "string" || !agent().sessions.get(sessionId)) throw new Error(`[oneai] conversation inconnue : ${String(sessionId)}`);
      const o = override && typeof override === "object" ? (override as { provider?: unknown; model?: unknown }) : null;
      if (!o?.model) {
        agent().updateSessionContext(sessionId, { modelPinned: false });
        return true;
      }
      if (typeof o.provider !== "string" || typeof o.model !== "string") throw new Error("[oneai] set-session-model-override : fournisseur et modèle texte attendus");
      if (!agent().providers.list().some((p) => p.id === o.provider)) throw new Error(`[oneai] fournisseur inconnu de Jarod : ${o.provider}`);
      agent().updateSessionContext(sessionId, { provider: o.provider, model: o.model, modelPinned: true });
      return true;
    },
    /**
     * register.ts:2224-2243 : dossiers liés, du plus récent au plus ancien, sans doublon (défaut 20). Jarod :
     * les `workspace` des conversations, par dernière activité (une seule source : pas de cache à compléter).
     */
    "list-recent-session-context-folders": (limit?: unknown): string[] => {
      const lim = typeof limit === "number" && limit > 0 ? limit : 20;
      const seen = new Set<string>();
      for (const s of agent().sessions.list(Number.MAX_SAFE_INTEGER).sort((a, b) => b.updatedAt - a.updatedAt)) {
        const w = s.context?.workspace;
        if (w && !seen.has(w)) seen.add(w);
        if (seen.size >= lim) break;
      }
      return [...seen];
    },
  };
}
