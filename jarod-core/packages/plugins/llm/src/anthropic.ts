// Portage de packages/core/src/providers/anthropic.ts (rév. 2e180305).
import Anthropic from "@anthropic-ai/sdk";
import { describeAttachment } from "@jarod/plugin-rag";
import type { ToolCall } from "@jarod/contracts";
import { redactText } from "@jarod/kernel/redact";
import {
  type ChatRequest,
  type ChatResult,
  type ChatTurn,
  type ProviderClient,
  ProviderError,
  type StreamHandlers,
} from "@jarod/contracts";

/** Content block types that are valid to send back to the API on the next turn. */
const REPLAYABLE = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

/** Models that get the server-side refusal fallback by default. */
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5-1"]);

const safeToolId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";

export function toAnthropicMessages(turns: ChatTurn[], model: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      if (!t.attachments?.length) {
        out.push({ role: "user", content: t.content });
        continue;
      }
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const a of t.attachments) {
        if (a.kind === "image" && a.data) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: a.mime as Anthropic.Base64ImageSource["media_type"], data: a.data },
          });
        } else if (a.kind === "pdf" && a.data) {
          blocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: a.data },
            title: a.name,
          });
        } else {
          blocks.push({ type: "text", text: describeAttachment(a) });
        }
      }
      blocks.push({ type: "text", text: t.content || "(voir les pièces jointes)" });
      out.push({ role: "user", content: blocks });
    } else if (t.role === "assistant") {
      // Same provider + model: replay the native blocks (keeps thinking signatures intact).
      if (t.provider === "anthropic" && t.model === model && Array.isArray(t.raw) && t.raw.length > 0) {
        out.push({ role: "assistant", content: t.raw as Anthropic.ContentBlockParam[] });
        continue;
      }
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (t.content) blocks.push({ type: "text", text: t.content });
      for (const c of t.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: safeToolId(c.id), name: c.name, input: c.args });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "(réponse vide)" });
      out.push({ role: "assistant", content: blocks });
    } else {
      // All tool results of one step go back together in a single user message.
      const result: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: safeToolId(t.toolCallId ?? ""),
        content: t.content || "(aucune sortie)",
        ...(t.isError ? { is_error: true } : {}),
      };
      const prev = out[out.length - 1];
      if (prev?.role === "user" && Array.isArray(prev.content) && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(result);
      } else {
        out.push({ role: "user", content: [result] });
      }
    }
  }
  return out;
}

export class AnthropicClient implements ProviderClient {
  private readonly client: Anthropic;

  constructor(apiKey: string | undefined, baseUrl?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? null,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }

  async chat(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const isHaiku = req.model.includes("haiku");
    const params: Anthropic.MessageStreamParams & Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 64000,
      messages: toAnthropicMessages(req.messages, req.model),
      // Caches tools + system + history up to the last block: each agent step re-reads the
      // whole conversation, which then costs ~10% instead of full price.
      cache_control: { type: "ephemeral" },
    };
    if (req.system) params.system = req.system;
    if (req.tools.length) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
        eager_input_streaming: true,
      }));
    }
    if (req.thinking && !isHaiku) params.thinking = { type: "adaptive", display: "summarized" };
    if (req.effort && !isHaiku) params.output_config = { effort: req.effort as Anthropic.OutputConfig["effort"] };

    const headers: Record<string, string> = {};
    if (req.anthropicFallbacks && FALLBACK_MODELS.has(req.model)) {
      params.fallbacks = "default";
      headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    }

    // With eager input streaming the API no longer validates tool JSON; if the SDK cannot
    // parse a tool input we re-issue the turn once (API errors are never retried here).
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.streamOnce(params, headers, req.signal, handlers);
      } catch (err) {
        if (err instanceof Anthropic.APIError) {
          throw new ProviderError(describeApiError(err), err.status);
        }
        if (req.signal?.aborted || attempt >= 1 || !(err instanceof SyntaxError || /JSON/i.test(String(err)))) {
          throw err;
        }
        handlers.onReset?.();
      }
    }
  }

  private async streamOnce(
    params: Anthropic.MessageStreamParams,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    handlers: StreamHandlers,
  ): Promise<ChatResult> {
    const stream = this.client.messages.stream(params, { headers, ...(signal ? { signal } : {}) });
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") handlers.onText?.(event.delta.text);
        else if (event.delta.type === "thinking_delta") handlers.onThinking?.(event.delta.thinking);
      }
    }
    const final = await stream.finalMessage();

    let text = "";
    let thinking = "";
    const toolCalls: ToolCall[] = [];
    for (const block of final.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") thinking += block.thinking;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
      }
    }

    const stop = final.stop_reason ?? "end_turn";
    if (stop === "max_tokens" && toolCalls.length) {
      throw new ProviderError("Réponse tronquée (max_tokens) pendant un appel d'outil : relancez avec /retry.");
    }
    if (stop === "refusal") {
      const details = (final as { stop_details?: { category?: string | null; explanation?: string } }).stop_details;
      text += `\n\n> ⚠️ Le modèle a refusé cette demande${details?.category ? ` (${details.category})` : ""}.`;
      return {
        text,
        thinking,
        toolCalls: [],
        stopReason: stop,
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };
    }

    const usage = final.usage;
    return {
      text,
      thinking,
      toolCalls,
      stopReason: stop,
      inputTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      raw: final.content.filter((b) => REPLAYABLE.has(b.type)),
      servedModel: final.model,
    };
  }
}

function describeApiError(err: InstanceType<typeof Anthropic.APIError>): string {
  if (err instanceof Anthropic.AuthenticationError) return "Clé API Anthropic invalide ou absente.";
  if (err instanceof Anthropic.RateLimitError) return "Limite de débit Anthropic atteinte : réessayez dans un instant.";
  if (err instanceof Anthropic.NotFoundError) return `Modèle ou ressource introuvable : ${redactText(err.message)}`;
  return `Erreur API Anthropic ${err.status ?? ""}: ${redactText(err.message)}`;
}
