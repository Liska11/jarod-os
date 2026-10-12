// Portage de packages/core/src/providers/openai.ts (rév. 2e180305).
import { describeAttachment } from "@jarod/plugin-rag";
import type { ToolCall } from "@jarod/contracts";
import { redactText } from "@jarod/kernel/redact";
import { parseJson, SseParser } from "@jarod/kernel/util";
import {
  type ChatRequest,
  type ChatResult,
  type ChatTurn,
  type ProviderClient,
  ProviderError,
  type StreamHandlers,
} from "@jarod/contracts";

type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAIMessages(system: string, turns: ChatTurn[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const t of turns) {
    if (t.role === "user") {
      if (!t.attachments?.length) {
        out.push({ role: "user", content: t.content });
        continue;
      }
      const parts: OpenAIContentPart[] = [];
      for (const a of t.attachments) {
        if (a.kind === "image" && a.data)
          parts.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${a.data}` } });
        else parts.push({ type: "text", text: describeAttachment(a) });
      }
      parts.push({ type: "text", text: t.content });
      out.push({ role: "user", content: parts });
    } else if (t.role === "assistant") {
      const msg: OpenAIMessage = { role: "assistant", content: t.content || null };
      if (t.toolCalls?.length) {
        msg.tool_calls = t.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      out.push(msg);
    } else {
      out.push({ role: "tool", tool_call_id: t.toolCallId ?? "", content: t.content });
    }
  }
  return out;
}

/** Delay before retry n: Retry-After when given (capped at 30 s), else 1 s, 2 s, 4 s… with jitter. */
export function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  return Math.min(1000 * 2 ** (attempt - 1), 16_000) * (0.8 + Math.random() * 0.4);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/**
 * An error the server sent inside the stream (`{"error": …}`), said in words. A local server that
 * cuts the generation short ("terminated", context overflow) most often got a request larger than
 * the context the model was loaded with — the agent's tool list alone is several thousand tokens —
 * so the message says how large the request was and where to raise the limit.
 */
export function describeStreamError(error: unknown, requestChars: number, tools: number): string {
  const o = (error && typeof error === "object" ? error : {}) as { message?: unknown; type?: unknown; code?: unknown };
  const message =
    typeof error === "string" ? error : typeof o.message === "string" && o.message ? o.message : JSON.stringify(error);
  const base = `Le serveur a interrompu la génération : ${redactText(message)}`;
  if (!/terminated|context|n_ctx|too long|exceed|tokens to keep/i.test(message)) return base;
  // ~3.5 characters per token for this mix of French text and JSON schemas.
  const approx = Math.round(requestChars / 3.5 / 100) * 100;
  return `${base}\nLa requête faisait environ ${approx} tokens (${tools} outils). Avec un modèle local, vérifiez que sa longueur de contexte la contient (16 384 ou plus). LM Studio : réglage « Context Length » du modèle au chargement, ou en ligne de commande \`lms load <modèle> --context-length 16384\` ; llama.cpp : « Context size » du préréglage. Un modèle déjà chargé garde son ancien contexte : rechargez-le.`;
}

/** Client for any OpenAI Chat Completions-compatible endpoint (streaming + function calling). */
export class OpenAICompatibleClient implements ProviderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", ...this.extraHeaders };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /**
   * POSTs with retries on rate limits, server errors and dropped connections (before anything
   * was streamed, so a retry never duplicates output). Honors Retry-After.
   */
  private async post(path: string, body: string, signal?: AbortSignal, attempts = 4): Promise<Response> {
    attempts = Math.max(1, attempts);
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url(path), { method: "POST", headers: this.headers(), body, signal: signal ?? null });
      } catch (e) {
        if (signal?.aborted || attempt >= attempts) throw e;
        await sleep(backoff(attempt, null), signal);
        continue;
      }
      if (res.ok && res.body) return res;
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && attempt < attempts) {
        await res.body?.cancel().catch(() => {});
        await sleep(backoff(attempt, res.headers.get("retry-after")), signal);
        continue;
      }
      const text = await res.text().catch(() => "");
      // Un fournisseur peut citer l'en-tête qu'il rejette : la clé ne doit ni s'afficher ni entrer dans le journal (AV2-009).
      throw new ProviderError(`HTTP ${res.status}: ${redactText(text).slice(0, 800)}`, res.status);
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(this.url("/models"), { headers: this.headers() });
    if (!res.ok) throw new ProviderError(`${res.status} ${redactText(await res.text()).slice(0, 800)}`, res.status);
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id).sort();
  }

  async chat(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (req.effort) body.reasoning_effort = req.effort === "xhigh" || req.effort === "max" ? "high" : req.effort;

    const payload = JSON.stringify(body);
    const requestChars = payload.length;
    const res = await this.post("/chat/completions", payload, req.signal, req.maxAttempts);

    let text = "";
    let thinking = "";
    let stopReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    const calls = new Map<number, ToolCallAccumulator>();

    const parser = new SseParser((_event, data) => {
      if (data === "[DONE]") return;
      const chunk = parseJson<Record<string, any> | null>(data, null);
      if (!chunk) return;
      if (chunk.error) throw new ProviderError(describeStreamError(chunk.error, requestChars, req.tools.length));
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? cacheReadTokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      const reasoning: unknown = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) {
        thinking += reasoning;
        handlers.onThinking?.(reasoning);
      }
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        handlers.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx: number = tc.index ?? 0;
        let acc = calls.get(idx);
        if (!acc) {
          acc = { id: "", name: "", args: "" };
          calls.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    });

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.flush();

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({
        id: c.id || `call_${i}_${Date.now()}`,
        name: c.name,
        args: parseJson<Record<string, unknown>>(c.args, { __invalid_json__: c.args }),
      }));

    // A response cut off by the length limit can carry half-written tool arguments: never run those.
    if (stopReason === "length" && toolCalls.length) {
      throw new ProviderError("Réponse tronquée (limite de tokens) pendant un appel d'outil.");
    }

    return {
      text,
      thinking,
      toolCalls,
      stopReason,
      inputTokens,
      outputTokens,
      ...(cacheReadTokens ? { cacheReadTokens } : {}),
    };
  }
}
