/**
 * Repli LLM sur les fixtures DIFFICILES : requête et lecture de la réponse (partie PURE, aucun serveur contacté).
 * Variante de `q16-chat-core.ts` (laissé intact : il a servi au run figé du 2026-09-29) avec trois changements voulus :
 *  - la sortie est `{intent, effect, risk}` et CHACUN des trois champs est nullable ;
 *  - la consigne dit : abstention → `intent`, `effect` et `risk` TOUS à `null`, jamais « effet faux » ni « risque 0 » ;
 *  - une abstention est une réponse valide (`HardAnswer` tout nul), distincte d'une réponse inutilisable (`answer: null`).
 * AUCUNE normalisation côté harnais : une sortie incohérente (ex. `intent: null` avec `risk: 0`) est rendue telle quelle
 * et la notation la juge fausse (`q16-hard-core.ts`). Normaliser avant de noter cacherait exactement l'erreur que la règle
 * d'abstention à trois champs sert à mesurer.
 */
import type { HardAnswer } from "./q16-hard-core.js";
import { CHAT_SYSTEM, chatRequestBody } from "./q16-chat-core.js";
import { HARD_QUESTIONS } from "./q16-hard-fixtures.js";
import { INTENTS, type Intent } from "./q16-fixtures.js";

const RISK_INSTRUCTIONS = HARD_QUESTIONS.find((q) => q.id === "risk")!.instructions;

export const HARD_CHAT_SYSTEM = [
  CHAT_SYSTEM,
  `risk (0, 1 or 2): ${RISK_INSTRUCTIONS}`,
  "Abstention: if the request alone does not let you decide (it refers to something that is not in the text, such as 'yes, go ahead' or 'as usual'), abstain by setting intent, effect and risk ALL to null.",
  "An abstention is never effect=false or risk=0: those are answers. Otherwise never use null.",
].join("\n");

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });

/** Les trois champs obligatoires et nullables. L'état incohérent reste représentable à dessein (voir l'en-tête). */
export const HARD_CHAT_SCHEMA = {
  type: "object",
  properties: {
    intent: nullable({ type: "string", enum: [...INTENTS] }),
    effect: nullable({ type: "boolean" }),
    risk: nullable({ type: "integer", enum: [0, 1, 2] }),
  },
  required: ["intent", "effect", "risk"],
  additionalProperties: false,
} as const;

/** Mêmes réglages figés que le repli facile (température 0, graine 1, sans cache, raisonnement coupé) ; seuls consigne et schéma changent. */
export function hardChatRequestBody(model: string, request: string): Record<string, unknown> {
  return {
    ...chatRequestBody(model, request),
    messages: [
      { role: "system", content: HARD_CHAT_SYSTEM },
      { role: "user", content: request },
    ],
    response_format: { type: "json_schema", json_schema: { name: "decision", strict: true, schema: HARD_CHAT_SCHEMA } },
  };
}

export interface HardChatParsed {
  /** `null` = réponse inutilisable (jamais devinée) ; un tout-nul est une ABSTENTION, pas une erreur. */
  answer: HardAnswer | null;
  error?: string;
  reasoningLeak: boolean;
}

/** Lit `/v1/chat/completions` ; toute anomalie donne `answer: null` + `error`, rien n'est corrigé ni complété. */
export function parseHardChatResponse(json: unknown): HardChatParsed {
  const msg = (json as { choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[] }).choices?.[0]?.message;
  const reasoningLeak = typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim() !== "";
  if (typeof msg?.content !== "string") return { answer: null, error: "pas de contenu", reasoningLeak };
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(msg.content) as Record<string, unknown>;
  } catch {
    return { answer: null, error: "JSON invalide", reasoningLeak };
  }
  if (d === null || typeof d !== "object" || Array.isArray(d)) return { answer: null, error: "hors schéma", reasoningLeak };
  const { intent, effect, risk } = d;
  const intentOk = intent === null || (typeof intent === "string" && (INTENTS as readonly string[]).includes(intent));
  const effectOk = effect === null || typeof effect === "boolean";
  const riskOk = risk === null || risk === 0 || risk === 1 || risk === 2;
  // `in` : une clé absente (≠ null explicite) est une réponse hors schéma.
  if (!("intent" in d && "effect" in d && "risk" in d) || !intentOk || !effectOk || !riskOk) return { answer: null, error: "hors schéma", reasoningLeak };
  return { answer: { intent: intent as Intent | null, effect: effect as boolean | null, risk: risk as HardAnswer["risk"] }, reasoningLeak };
}
