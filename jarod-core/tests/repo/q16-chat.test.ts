// Mesure Q16-chat (informative) : la requête porte les trois choix figés (raisonnement coupé, schéma JSON, déterminisme) et la
// notation ne devine rien (réponse inutilisable = fausse). Aucun serveur n'est contacté.
import { describe, expect, it } from "vitest";
import { CHAT_SCHEMA, CHAT_SYSTEM, type ChatCall, chatRequestBody, parseChatResponse, scoreChat } from "../bench/q16-chat-core.js";
import { effectOf, FIXTURES, INTENTS } from "../bench/q16-fixtures.js";

const call = (i: number, over: Partial<ChatCall> = {}): ChatCall => ({
  i,
  intent: FIXTURES[i]!.intent,
  effect: effectOf(FIXTURES[i]!.intent),
  clientMs: 100 + i,
  promptMs: 10,
  predictedMs: 20,
  promptTokens: 200,
  completionTokens: 12,
  reasoningLeak: false,
  ...over,
});

describe("Q16-chat : requête", () => {
  const body = chatRequestBody("m", "Rappelle-moi de sortir le chien.") as Record<string, any>;

  it("raisonnement coupé, schéma JSON strict, température 0, sans cache de prompt", () => {
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "decision", strict: true, schema: CHAT_SCHEMA } });
    expect(body.temperature).toBe(0);
    expect(body.cache_prompt).toBe(false);
    expect(body.stream).toBe(false);
  });

  it("mêmes intents et mêmes descriptions que Laya et bge-m3", () => {
    expect(CHAT_SCHEMA.properties.intent.enum).toEqual([...INTENTS]);
    for (const i of INTENTS) expect(CHAT_SYSTEM).toContain(`- ${i}: `);
    expect(body.messages[1]).toEqual({ role: "user", content: "Rappelle-moi de sortir le chien." });
  });
});

describe("Q16-chat : réponse et notation", () => {
  const ok = (content: string, extra: object = {}) => ({ choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 210, completion_tokens: 9 }, timings: { prompt_ms: 12.5, predicted_ms: 30 } });

  it("lit intent + effect, les temps du serveur et signale un raisonnement qui fuit", () => {
    expect(parseChatResponse(ok('{"intent":"web","effect":false}'))).toMatchObject({ intent: "web", effect: false, promptMs: 12.5, predictedMs: 30, promptTokens: 210, reasoningLeak: false });
    expect(parseChatResponse(ok('{"intent":"chat","effect":false}', { reasoning_content: "hmm" })).reasoningLeak).toBe(true);
  });

  it("aucune valeur devinée : JSON invalide, valeur hors enum, contenu absent", () => {
    expect(parseChatResponse(ok("pas du json"))).toMatchObject({ intent: null, effect: null, error: "JSON invalide" });
    expect(parseChatResponse(ok('{"intent":"cuisine","effect":true}'))).toMatchObject({ intent: null, error: "hors schéma" });
    expect(parseChatResponse({ choices: [] })).toMatchObject({ intent: null, error: "pas de contenu" });
  });

  it("60 réponses justes : 60/60, effet 60/60, rappels 12/12 ; une réponse inutilisable compte comme fausse", () => {
    const all = FIXTURES.map((_, i) => call(i));
    const s = scoreChat(all);
    expect(s).toMatchObject({ total: 60, usable: 60, intentHits: 60, effectHits: 60, reminderHits: 12, reminderTotal: 12, effectMajority: 36, reasoningLeaks: 0 });
    const broken = scoreChat(all.map((c) => (c.i === 30 ? call(30, { intent: null, effect: null, error: "JSON invalide" }) : c)));
    expect(broken).toMatchObject({ usable: 59, intentHits: 59, effectHits: 59 });
    expect(broken.confusion[FIXTURES[30]!.intent]!.invalide).toBe(1);
  });

  it("la matrice de confusion et les percentiles suivent les appels", () => {
    const i = FIXTURES.findIndex((f) => f.intent === "reminder");
    const s = scoreChat(FIXTURES.map((_, k) => (k === i ? call(k, { intent: "action" }) : call(k))));
    expect(s.confusion.reminder!.action).toBe(1);
    expect(s.reminderHits).toBe(11);
    expect(s.clientMs.p50).toBe(129);
  });
});
