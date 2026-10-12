// Repli LLM sur les fixtures difficiles : requête (schéma à trois champs nullables, consigne d'abstention), lecture de la réponse
// sans normalisation ni devinette. Aucun serveur n'est contacté.
import { describe, expect, it } from "vitest";
import { HARD_CHAT_SCHEMA, HARD_CHAT_SYSTEM, hardChatRequestBody, parseHardChatResponse } from "../bench/q16-hard-chat-core.js";
import { isCorrect, scoreHard } from "../bench/q16-hard-core.js";
import { HARD_FIXTURES } from "../bench/q16-hard-fixtures.js";
import { chatRequestBody } from "../bench/q16-chat-core.js";

const reply = (content: unknown, extra: Record<string, unknown> = {}) => ({ choices: [{ message: { content, ...extra } }] });
const json = (o: unknown) => reply(JSON.stringify(o));
const under = HARD_FIXTURES.find((f) => f.id === "under-1")!;

describe("Q16 repli difficile : requête", () => {
  const body = hardChatRequestBody("m", "Oui, vas-y.") as Record<string, any>;

  it("réglages figés identiques au repli facile ; seuls la consigne et le schéma changent", () => {
    const easy = chatRequestBody("m", "Oui, vas-y.") as Record<string, any>;
    const { messages: _m, response_format: _r, ...restHard } = body;
    const { messages: _m2, response_format: _r2, ...restEasy } = easy;
    expect(restHard).toEqual(restEasy);
    expect(body.temperature).toBe(0);
    expect(body.seed).toBe(1);
    expect(body.cache_prompt).toBe(false);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages).toEqual([
      { role: "system", content: HARD_CHAT_SYSTEM },
      { role: "user", content: "Oui, vas-y." },
    ]);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "decision", strict: true, schema: HARD_CHAT_SCHEMA } });
  });

  it("schéma : intent, effect et risk obligatoires ET nullables, rien d'autre", () => {
    expect(HARD_CHAT_SCHEMA.required).toEqual(["intent", "effect", "risk"]);
    expect(HARD_CHAT_SCHEMA.additionalProperties).toBe(false);
    for (const k of ["intent", "effect", "risk"] as const) {
      const alts = HARD_CHAT_SCHEMA.properties[k].anyOf as readonly Record<string, unknown>[];
      expect(alts.some((a) => a.type === "null"), k).toBe(true);
    }
    expect(Object.keys(HARD_CHAT_SCHEMA.properties)).toEqual(["intent", "effect", "risk"]);
  });

  it("consigne : abstention → intent, effect et risk tous à null ; « effet faux » et « risque 0 » sont des réponses", () => {
    expect(HARD_CHAT_SYSTEM).toContain("intent, effect and risk ALL to null");
    expect(HARD_CHAT_SYSTEM).toContain("never effect=false or risk=0");
    expect(HARD_CHAT_SYSTEM).toContain("risk (0, 1 or 2)");
  });
});

describe("Q16 repli difficile : lecture de la réponse", () => {
  it("réponse décidée", () => {
    expect(parseHardChatResponse(json({ intent: "action", effect: true, risk: 2 })).answer).toEqual({ intent: "action", effect: true, risk: 2 });
  });

  it("abstention tout nulle = réponse VALIDE (pas une erreur) et juste sur un cas sous-spécifié", () => {
    const p = parseHardChatResponse(json({ intent: null, effect: null, risk: null }));
    expect(p.error).toBeUndefined();
    expect(p.answer).toEqual({ intent: null, effect: null, risk: null });
    expect(isCorrect(under, p.answer)).toBe(true);
  });

  it("aucune normalisation : intent nul avec risque 0 est rendu tel quel et jugé faux", () => {
    const p = parseHardChatResponse(json({ intent: null, effect: null, risk: 0 }));
    expect(p.answer).toEqual({ intent: null, effect: null, risk: 0 });
    expect(isCorrect(under, p.answer)).toBe(false);
    const q = parseHardChatResponse(json({ intent: null, effect: false, risk: null }));
    expect(q.answer).toEqual({ intent: null, effect: false, risk: null });
    expect(isCorrect(under, q.answer)).toBe(false);
  });

  it("inutilisable (jamais devinée) : pas de contenu, JSON invalide, clé absente, hors enum, risque hors 0-2 ou textuel, mauvais types", () => {
    const bad: unknown[] = [
      {},
      { choices: [] },
      reply(null),
      reply("pas du json"),
      reply("[]"),
      reply("null"),
      json({ intent: "chat", effect: false }), // risk absent ≠ null explicite
      json({ effect: false, risk: 0 }),
      json({ intent: "météo", effect: false, risk: 0 }),
      json({ intent: "chat", effect: "non", risk: 0 }),
      json({ intent: "chat", effect: false, risk: 3 }),
      json({ intent: "chat", effect: false, risk: "1" }),
      json({ intent: "chat", effect: false, risk: 0.5 }),
      json({ intent: 3, effect: false, risk: 0 }),
    ];
    for (const b of bad) {
      const p = parseHardChatResponse(b);
      expect(p.answer, JSON.stringify(b)).toBeNull();
      expect(p.error, JSON.stringify(b)).toBeTruthy();
    }
  });

  it("fuite de raisonnement relevée", () => {
    expect(parseHardChatResponse(reply('{"intent":null,"effect":null,"risk":null}', { reasoning_content: "hmm" })).reasoningLeak).toBe(true);
    expect(parseHardChatResponse(json({ intent: "chat", effect: false, risk: 0 })).reasoningLeak).toBe(false);
  });
});

describe("Q16 repli difficile : abstentions partielles comptées à part", () => {
  it("intent nul avec un autre champ renseigné = abstention partielle (fausse), pas une abstention", () => {
    const gold = (f: (typeof HARD_FIXTURES)[number]) => ({ intent: f.intent, effect: f.effect, risk: f.risk });
    const answers = HARD_FIXTURES.map((f) => (f.id === "under-1" ? { intent: null, effect: null, risk: 0 as const } : gold(f)));
    const s = scoreHard(HARD_FIXTURES, answers);
    expect(s.partialAbstentions).toBe(1);
    expect(s.abstained).toBe(s.abstentionExpected - 1);
    expect(s.abstentionCorrect).toBe(s.abstentionExpected - 1);
    expect(s.correct).toBe(HARD_FIXTURES.length - 1);
  });
});
