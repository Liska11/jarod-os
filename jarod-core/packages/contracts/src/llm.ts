// Portage de packages/core/src/providers/types.ts (rév. 2e180305) : contrat LLM (stream, usage, AbortSignal).
import type { Attachment, Role, ToolCall } from "./domain.js";

export type Protocol = "openai" | "anthropic";

export interface ProviderDef {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /** Local servers (Ollama, LM Studio…) work without an API key. */
  local?: boolean;
  models: string[];
  keyUrl?: string;
}

/** Provider-neutral conversation turn. */
export interface ChatTurn {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  provider?: string;
  model?: string;
  raw?: unknown;
  attachments?: LoadedAttachment[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatTurn[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  thinking?: boolean;
  effort?: string;
  maxTokens?: number;
  /**
   * Attempts on a rate limit or a server error before giving up. Lower when a fallback (another key
   * or provider) is ready: waiting 30 s on a busy provider is pointless when another one answers.
   */
  maxAttempts?: number;
  anthropicFallbacks?: boolean;
}

export interface StreamHandlers {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  /** The provider is re-issuing the turn: discard what was streamed so far. */
  onReset?(): void;
}

export interface ChatResult {
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  /** Part of inputTokens read from the provider's prompt cache (billed ~10%). */
  cacheReadTokens?: number;
  /** Part of inputTokens written to the prompt cache (billed ~125% on Claude). */
  cacheWriteTokens?: number;
  /** Provider-native assistant content to replay on the next request. */
  raw?: unknown;
  /** Model that actually served the request (may differ after a fallback). */
  servedModel?: string;
}

export interface ProviderClient {
  chat(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>;
  listModels(): Promise<string[]>;
}

/**
 * What a failed call says about where to go next: `key` when the key itself is refused or rate
 * limited (another key of the same provider may work), `provider` when the provider is down or out
 * of reach, null when the request is at fault (another provider would refuse it too).
 */
export function failoverKind(err: unknown): "key" | "provider" | null {
  const status = err instanceof ProviderError ? err.status : undefined;
  if (status === 401 || status === 402 || status === 403 || status === 429) return "key";
  if (status === 408 || status === 409 || (status !== undefined && status >= 500)) return "provider";
  if (status !== undefined) return null;
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } } | null;
  const code = e?.code ?? e?.cause?.code ?? "";
  if (/^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|EPIPE|ENETUNREACH|EHOSTUNREACH)/.test(code)) return "provider";
  if (e?.name === "TimeoutError" || /fetch failed|network|socket hang up|Aucune clé API/i.test(e?.message ?? "")) {
    return "provider";
  }
  return null;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// services/attachments.ts:11-11
export type AttachmentKind = "image" | "pdf" | "text" | "binary";

// services/attachments.ts:13-20 (fait partie du contrat : ce que reçoit un fournisseur)
/** An attachment with its content, ready to be sent to a provider. */
export interface LoadedAttachment extends Attachment {
  kind: AttachmentKind;
  /** base64 payload for images and PDFs */
  data?: string;
  /** decoded content for text files */
  text?: string;
}
