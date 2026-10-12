/**
 * Q16 — mesure INFORMATIVE du LLM de chat comme moteur de décision (« repli LLM natif » : raisonnement
 * désactivé + sortie contrainte par un schéma JSON) sur les 60 fixtures FR de `q16-fixtures.ts`. Partie
 * PURE (corps de requête, notation) : testée sans serveur. Méthode figée avant tout run (DECISIONS
 * 2026-09-29 « Q16 — mesure du LLM de chat ») : AUCUN seuil, AUCUN verdict — chiffres relevés à titre de repère.
 */
import { effectOf, FIXTURES, INTENT_DESCRIPTIONS, INTENTS, type Intent, QUESTIONS } from "./q16-fixtures.js";

/** Mêmes questions et mêmes descriptions d'options que pour Laya et bge-m3 (`q16-fixtures.ts`). */
export const CHAT_SYSTEM = [
  "You are a request router. Read the user's request (it may be in any language) and answer with a JSON object.",
  `intent: ${QUESTIONS[0]!.instructions} Options:`,
  ...INTENTS.map((i) => `- ${i}: ${INTENT_DESCRIPTIONS[i]}`),
  `effect (true/false): ${QUESTIONS[1]!.instructions}`,
].join("\n");

export const CHAT_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string", enum: [...INTENTS] }, effect: { type: "boolean" } },
  required: ["intent", "effect"],
  additionalProperties: false,
} as const;

/**
 * Requête d'une décision : déterministe (température 0, graine fixe), sans cache de prompt (chaque appel est
 * traité en entier : la latence n'est pas celle d'un préfixe déjà vu), raisonnement coupé côté gabarit
 * (`enable_thinking: false`, gabarit Qwen3.5 du serveur), sortie contrainte par le schéma.
 */
export function chatRequestBody(model: string, request: string): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: CHAT_SYSTEM },
      { role: "user", content: request },
    ],
    temperature: 0,
    seed: 1,
    max_tokens: 96,
    stream: false,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: CHAT_SCHEMA } },
  };
}

export interface ChatCall {
  i: number;
  /** null = réponse inutilisable (JSON invalide, valeur hors enum, erreur HTTP, hors délai). */
  intent: Intent | null;
  effect: boolean | null;
  clientMs: number;
  promptMs: number | null;
  predictedMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Du texte de raisonnement est revenu malgré `enable_thinking: false`. */
  reasoningLeak: boolean;
  error?: string;
}

/** Extrait la décision d'une réponse `/v1/chat/completions` ; toute anomalie donne `null` + `error`, jamais une valeur devinée. */
export function parseChatResponse(json: unknown): Pick<ChatCall, "intent" | "effect" | "reasoningLeak" | "promptMs" | "predictedMs" | "promptTokens" | "completionTokens" | "error"> {
  const r = json as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    timings?: { prompt_ms?: number; predicted_ms?: number };
  };
  const msg = r.choices?.[0]?.message;
  const base = {
    reasoningLeak: typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim() !== "",
    promptMs: r.timings?.prompt_ms ?? null,
    predictedMs: r.timings?.predicted_ms ?? null,
    promptTokens: r.usage?.prompt_tokens ?? null,
    completionTokens: r.usage?.completion_tokens ?? null,
  };
  if (typeof msg?.content !== "string") return { ...base, intent: null, effect: null, error: "pas de contenu" };
  let d: { intent?: unknown; effect?: unknown };
  try {
    d = JSON.parse(msg.content);
  } catch {
    return { ...base, intent: null, effect: null, error: "JSON invalide" };
  }
  if (typeof d.intent !== "string" || !(INTENTS as readonly string[]).includes(d.intent) || typeof d.effect !== "boolean")
    return { ...base, intent: null, effect: null, error: "hors schéma" };
  return { ...base, intent: d.intent as Intent, effect: d.effect };
}

const pct = (xs: readonly number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! * 100) / 100 : null;
};

export interface ChatScore {
  total: number;
  /** Réponses utilisables. */
  usable: number;
  intentHits: number;
  /** « la demande change quelque chose » juste (24 vrais / 36 faux dans les fixtures). */
  effectHits: number;
  /** Classe majoritaire de l'effet, pour repère. */
  effectMajority: number;
  /** Rappels (`reminder`) correctement routés, sur 12. */
  reminderHits: number;
  reminderTotal: number;
  confusion: Record<string, Record<string, number>>;
  reasoningLeaks: number;
  clientMs: { p50: number | null; p95: number | null };
  promptMs: { p50: number | null; p95: number | null };
  predictedMs: { p50: number | null; p95: number | null };
  promptTokensMedian: number | null;
  completionTokensMedian: number | null;
}

/** Notation d'un passage de 60 appels (un par fixture FR, dans l'ordre). Une réponse inutilisable compte comme fausse. */
export function scoreChat(calls: readonly ChatCall[]): ChatScore {
  const fr = FIXTURES;
  const byI = new Map(calls.map((c) => [c.i, c]));
  const confusion: ChatScore["confusion"] = Object.fromEntries(
    INTENTS.map((i) => [i, Object.fromEntries([...INTENTS, "invalide"].map((j) => [j, 0]))]),
  );
  let intentHits = 0;
  let effectHits = 0;
  let reminderHits = 0;
  fr.forEach((f, i) => {
    const c = byI.get(i);
    const got = c?.intent ?? "invalide";
    confusion[f.intent]![got]! += 1;
    if (c?.intent === f.intent) {
      intentHits++;
      if (f.intent === "reminder") reminderHits++;
    }
    if (c?.effect === effectOf(f.intent)) effectHits++;
  });
  const nums = (k: "clientMs" | "promptMs" | "predictedMs" | "promptTokens" | "completionTokens") =>
    calls.map((c) => c[k]).filter((x): x is number => typeof x === "number");
  const q = (k: "clientMs" | "promptMs" | "predictedMs") => ({ p50: pct(nums(k), 0.5), p95: pct(nums(k), 0.95) });
  return {
    total: fr.length,
    usable: calls.filter((c) => c.intent !== null && c.effect !== null).length,
    intentHits,
    effectHits,
    effectMajority: fr.filter((f) => !effectOf(f.intent)).length,
    reminderHits,
    reminderTotal: fr.filter((f) => f.intent === "reminder").length,
    confusion,
    reasoningLeaks: calls.filter((c) => c.reasoningLeak).length,
    clientMs: q("clientMs"),
    promptMs: q("promptMs"),
    predictedMs: q("predictedMs"),
    promptTokensMedian: pct(nums("promptTokens"), 0.5),
    completionTokensMedian: pct(nums("completionTokens"), 0.5),
  };
}
