// Portage verbatim de packages/core/src/types.ts (rév. 2e180305) : types de domaine partagés.
export type Role = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
  /** Provider-native payload replayed verbatim to the same provider/model (e.g. Claude thinking signatures). */
  raw?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  attachments?: Attachment[];
  /** `summary`: a compaction summary standing in for older (compacted) messages. */
  kind?: "summary";
  /** Replaced by a later summary: kept for display, no longer sent to the model. */
  compacted?: boolean;
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  messageCount: number;
  /** Workspace, model and mode this conversation runs with (set at its first run). */
  context?: SessionContext;
}

export interface SessionContext {
  workspace: string | null;
  provider: string;
  model: string;
  agentMode: "build" | "plan";
  /**
   * Jarod-cordis (Q10) : `true` = modèle ÉPINGLÉ pour cette conversation (elle le garde) ; absent/`false` =
   * elle suit le modèle actif. Absent d'un contexte à écrire = épingle inchangée.
   */
  modelPinned?: boolean;
}

export interface SearchHit {
  sessionId: string;
  title: string;
  snippet: string;
  updatedAt: number;
}

export type MemoryType = "fact" | "preference" | "context" | "conversation";

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface Notification {
  id: string;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  body: string;
  read: boolean;
  createdAt: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Encrypts secrets at rest. The desktop app backs this with Electron safeStorage (OS keychain / DPAPI). */
export interface Cipher {
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

export const plainCipher: Cipher = {
  encrypt: (s) => s,
  decrypt: (s) => s,
};
