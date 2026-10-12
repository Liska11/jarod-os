/**
 * Q13-1 — continuité de session (décision utilisateur 2026-09-28) : ce que l'écran Chat ré-affiche à la réouverture
 * d'une conversation. Portage de SANK-UI `src/main/session-continuation-store.ts` (rév. 3aaadb0, MIT ©
 * github.com/fathah) : normalisation (`:61-126`), erreurs locales (`:150-176`, `:195-259`), conversion en historique
 * (`:282-356`), relecture (`sessions.ts:704-708`). Tables de la migration v16 (`plugin-storage` `db.ts`) au lieu de
 * tables créées à la volée dans `state.db`.
 *
 * Écarts : conversation inconnue = erreur (SANK-UI : `true` sans écriture) ; pièces jointes GARDÉES en base (forme
 * SANK-UI normalisée) mais non relayées dans l'historique, comme les messages Jarod (`sessions.ts`, en-tête) ;
 * horodatages en millisecondes.
 */
import type { DesktopSessionContinuationItem, DesktopSessionLocalError } from "../sank/src/shared/session-continuation.js";

/** Accès à la base du profil (port structurel de `Db`, plugin-storage). */
export interface ContinuationDb {
  run(sql: string, ...params: (string | number | null)[]): { changes: number };
  get<T>(sql: string, ...params: (string | number | null)[]): T | undefined;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
}

export type ContinuationHistoryItem =
  | { kind: "user"; id: number; content: string; timestamp: number }
  | { kind: "assistant"; id: number; content: string; timestamp: number; error?: string }
  | { kind: "reasoning"; id: number; assistantId: number; text: string; timestamp: number }
  | { kind: "tool_call"; id: number; assistantId: number; callId: string; name: string; args: string; timestamp: number }
  | { kind: "tool_result"; id: number; callId: string; name: string; content: string; timestamp: number };

const SYNTHETIC_ID_BASE = -900_000_000;
const ERROR_SYNTHETIC_ID_BASE = -800_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

function cleanAttachments(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(isRecord);
  return out.length ? out : undefined;
}

/** `session-continuation-store.ts:61-126` (corps repris). */
export function normalizeContinuationItems(items: unknown): DesktopSessionContinuationItem[] {
  if (!Array.isArray(items)) return [];
  const out: DesktopSessionContinuationItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const kind = String(item.kind || "");
    if (kind === "user") {
      const content = typeof item.content === "string" ? item.content : "";
      const attachments = cleanAttachments(item.attachments);
      if (!content.trim() && !attachments) continue;
      out.push({ kind, content, ...(attachments ? { attachments } : {}) } as DesktopSessionContinuationItem);
      continue;
    }
    if (kind === "assistant") {
      const content = typeof item.content === "string" ? item.content : "";
      const error = typeof item.error === "string" ? item.error : "";
      const attachments = cleanAttachments(item.attachments);
      if (!content.trim() && !error.trim() && !attachments) continue;
      const visibleContent = error.trim() && normalizeText(content) === normalizeText(error) ? "" : content;
      out.push({ kind, content: visibleContent, ...(error.trim() ? { error } : {}), ...(attachments ? { attachments } : {}) } as DesktopSessionContinuationItem);
      continue;
    }
    if (kind === "reasoning") {
      const text = typeof item.text === "string" ? item.text : "";
      if (!text.trim()) continue;
      out.push({ kind, text });
      continue;
    }
    if (kind === "tool_call") {
      const callId = typeof item.callId === "string" ? item.callId : "";
      const name = typeof item.name === "string" ? item.name : "tool";
      const args = typeof item.args === "string" ? item.args : "";
      if (!callId && !name && !args.trim()) continue;
      out.push({ kind, callId, name, args });
      continue;
    }
    if (kind === "tool_result") {
      const callId = typeof item.callId === "string" ? item.callId : "";
      const name = typeof item.name === "string" ? item.name : "tool";
      const content = typeof item.content === "string" ? item.content : "";
      const attachments = cleanAttachments(item.attachments);
      if (!callId && !content.trim() && !attachments) continue;
      out.push({ kind, callId, name, content, ...(attachments ? { attachments } : {}) } as DesktopSessionContinuationItem);
    }
  }
  return out;
}

/** `:282-356` : éléments ré-affichés en tête, identifiants synthétiques négatifs (pièces jointes non relayées). */
export function continuationItemsToHistory(items: ReadonlyArray<DesktopSessionContinuationItem>): ContinuationHistoryItem[] {
  return items.map((item, index): ContinuationHistoryItem => {
    const id = SYNTHETIC_ID_BASE - index;
    const timestamp = index;
    switch (item.kind) {
      case "user":
        return { kind: "user", id, content: item.content, timestamp };
      case "assistant":
        return { kind: "assistant", id, content: item.content, timestamp, ...(item.error ? { error: item.error } : {}) };
      case "reasoning":
        return { kind: "reasoning", id, assistantId: id, text: item.text, timestamp };
      case "tool_call":
        return { kind: "tool_call", id, assistantId: id, callId: item.callId, name: item.name, args: item.args, timestamp };
      case "tool_result":
        return { kind: "tool_result", id, callId: item.callId, name: item.name, content: item.content, timestamp };
    }
  });
}

/** `:195-259` : chaque erreur locale se place après le message utilisateur qu'elle concerne (sinon à la fin). */
export function mergeSessionLocalErrors(items: ReadonlyArray<ContinuationHistoryItem>, errors: ReadonlyArray<DesktopSessionLocalError>): ContinuationHistoryItem[] {
  if (errors.length === 0) return [...items];
  const output: ContinuationHistoryItem[] = [];
  const used = new Set<number>();
  let errorOrdinal = 0;
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex]!;
    output.push(item);
    if (item.kind !== "user") continue;
    const userText = normalizeText(item.content);
    const nextItem = items[itemIndex + 1];
    if (nextItem?.kind === "assistant" && normalizeText(nextItem.error || "")) {
      for (let i = 0; i < errors.length; i++) {
        if (used.has(i)) continue;
        const error = errors[i]!;
        if (normalizeText(error.userContent) === userText && normalizeText(error.error) === normalizeText(nextItem.error || "")) {
          used.add(i);
          break;
        }
      }
      continue;
    }
    for (let i = 0; i < errors.length; i++) {
      if (used.has(i)) continue;
      const error = errors[i]!;
      if (normalizeText(error.userContent) !== userText) continue;
      used.add(i);
      output.push({ kind: "assistant", id: ERROR_SYNTHETIC_ID_BASE - errorOrdinal++, content: "", error: error.error, timestamp: item.timestamp + 0.000001 });
      break;
    }
  }
  for (let i = 0; i < errors.length; i++) {
    if (used.has(i)) continue;
    output.push({ kind: "assistant", id: ERROR_SYNTHETIC_ID_BASE - errorOrdinal++, content: "", error: errors[i]!.error, timestamp: Number.MAX_SAFE_INTEGER });
  }
  return output;
}

export class SessionContinuationStore {
  constructor(private readonly db: () => ContinuationDb) {}

  /** `:128-148` : remplace le début enregistré ; rien à garder = sans écriture. */
  recordContinuation(sessionId: string, items: unknown, now = Date.now()): void {
    const normalized = normalizeContinuationItems(items);
    if (normalized.length === 0) return;
    this.db().run(
      `INSERT INTO session_continuations (session_id, items, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`,
      sessionId,
      JSON.stringify(normalized),
      now,
      now,
    );
  }

  /** `:150-176` : une erreur (texte + demande non vides), sans doublon exact. */
  recordLocalError(sessionId: string, error: unknown, userContent: unknown, now = Date.now()): void {
    const errorText = typeof error === "string" ? error.trim() : "";
    const promptText = typeof userContent === "string" ? userContent.trim() : "";
    if (!errorText || !promptText) return;
    const existing = this.db().get("SELECT 1 AS x FROM session_local_errors WHERE session_id = ? AND user_content = ? AND error_text = ? LIMIT 1", sessionId, promptText, errorText);
    if (existing) return;
    this.db().run("INSERT INTO session_local_errors (session_id, user_content, error_text, created_at) VALUES (?, ?, ?, ?)", sessionId, promptText, errorText, now);
  }

  /** `sessions.ts:704-708` : début poursuivi, puis l'historique avec ses erreurs locales. */
  history(sessionId: string, canonical: ContinuationHistoryItem[]): ContinuationHistoryItem[] {
    const row = this.db().get<{ items: string }>("SELECT items FROM session_continuations WHERE session_id = ?", sessionId);
    let prefix: ContinuationHistoryItem[] = [];
    if (row?.items) {
      try {
        prefix = continuationItemsToHistory(normalizeContinuationItems(JSON.parse(row.items)));
      } catch {
        prefix = [];
      }
    }
    const errors = this.db()
      .all<{ user_content: string; error_text: string }>("SELECT user_content, error_text FROM session_local_errors WHERE session_id = ? ORDER BY id", sessionId)
      .map((r) => ({ userContent: r.user_content || "", error: r.error_text || "" }))
      .filter((r) => r.userContent.trim() && r.error.trim());
    return [...prefix, ...mergeSessionLocalErrors(canonical, errors)];
  }
}
