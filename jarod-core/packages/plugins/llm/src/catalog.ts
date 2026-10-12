// Portage de packages/core/src/providers/catalog.ts (rév. 2e180305).
import type { ProviderDef } from "@jarod/contracts";

/**
 * Built-in providers. Anything speaking the OpenAI Chat Completions dialect is served
 * by one client, which covers cloud APIs and local runtimes alike. Model lists are
 * starting points: "Actualiser" in the settings pulls the live list from /models.
 */
export const PROVIDERS: ProviderDef[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-opus-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-4-5"],
    keyUrl: "https://platform.claude.com/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: [],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "google",
    name: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [],
    keyUrl: "https://aistudio.google.com/apikey",
  },
  { id: "xai", name: "xAI (Grok)", protocol: "openai", baseUrl: "https://api.x.ai/v1", models: [] },
  { id: "mistral", name: "Mistral", protocol: "openai", baseUrl: "https://api.mistral.ai/v1", models: [] },
  { id: "deepseek", name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", models: [] },
  { id: "groq", name: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", models: [] },
  { id: "cerebras", name: "Cerebras", protocol: "openai", baseUrl: "https://api.cerebras.ai/v1", models: [] },
  { id: "together", name: "Together AI", protocol: "openai", baseUrl: "https://api.together.xyz/v1", models: [] },
  {
    id: "nous",
    name: "Nous Portal",
    protocol: "openai",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    models: [],
    keyUrl: "https://portal.nousresearch.com",
  },
  {
    id: "zai",
    name: "Z.ai (GLM)",
    protocol: "openai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: [],
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    protocol: "openai",
    baseUrl: "https://api.moonshot.ai/v1",
    models: [],
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
  },
  { id: "minimax", name: "MiniMax", protocol: "openai", baseUrl: "https://api.minimax.io/v1", models: [] },
  {
    id: "qwen",
    name: "Qwen (Alibaba Cloud)",
    protocol: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: [],
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: [],
  },
  { id: "nvidia", name: "NVIDIA NIM", protocol: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", models: [] },
  {
    id: "huggingface",
    name: "Hugging Face",
    protocol: "openai",
    baseUrl: "https://router.huggingface.co/v1",
    models: [],
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    local: true,
    models: [],
  },
  {
    id: "lmstudio",
    name: "LM Studio (local)",
    protocol: "openai",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    models: [],
  },
  {
    id: "llamacpp",
    name: "llama.cpp (local)",
    protocol: "openai",
    baseUrl: "http://localhost:8080/v1",
    local: true,
    models: [],
  },
  {
    id: "vllm",
    name: "vLLM (local)",
    protocol: "openai",
    baseUrl: "http://localhost:8000/v1",
    local: true,
    models: [],
  },
  // Jarod-cordis (G3, PLAN §4) : whisper.cpp local, supervisé par plugin-voice. Transcription seulement.
  {
    id: "local-whisper-cpp",
    name: "Whisper local (whisper.cpp, iGPU)",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:8910/v1",
    local: true,
    models: ["large-v3-turbo"],
  },
  {
    id: "custom",
    name: "Personnalisé (compatible OpenAI)",
    protocol: "openai",
    baseUrl: "http://localhost:8000/v1",
    local: true,
    models: [],
  },
];

/** USD per million tokens [input, output]; used for cost estimates only. */
const PRICING: [prefix: string, input: number, output: number][] = [
  ["claude-fable-5", 10, 50],
  ["claude-mythos-5", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4", 5, 25],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-4-5", 1, 5],
];

/**
 * Estimated USD cost. `inputTokens` includes cached tokens: cache reads bill ~10% of the input
 * price and cache writes ~125% (Claude, 5-minute cache).
 */
export function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number | null {
  if (!model) return null;
  const hit = PRICING.find(([prefix]) => model.startsWith(prefix));
  if (!hit) return null;
  const plain = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  return (
    (plain * hit[1] + cacheReadTokens * hit[1] * 0.1 + cacheWriteTokens * hit[1] * 1.25 + outputTokens * hit[2]) /
    1_000_000
  );
}
