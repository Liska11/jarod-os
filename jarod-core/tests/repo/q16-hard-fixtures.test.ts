// Fixtures difficiles du repli LLM (brouillon) : structure saine et notation pure (abstention = intent, effet et risque tous
// à null, double lecture jugée en entier, triage 40/70). Aucun serveur, aucun moteur.
import { DecisionQuestion } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { type HardAnswer, isAbstention, isCorrect, nextStep, readingsOf, scoreHard } from "../bench/q16-hard-core.js";
import { HARD_FIXTURES, HARD_QUESTIONS, KINDS, type HardFixture } from "../bench/q16-hard-fixtures.js";
import { FIXTURES, INTENTS } from "../bench/q16-fixtures.js";

const byId = (id: string): HardFixture => HARD_FIXTURES.find((x) => x.id === id)!;
const ans = (intent: HardAnswer["intent"], effect: HardAnswer["effect"], risk: HardAnswer["risk"]): HardAnswer => ({ intent, effect, risk });
/** Réponse qui égale la lecture principale de chaque fixture. */
const gold = (f: HardFixture): HardAnswer => ans(f.intent, f.effect, f.risk);

describe("Q16 fixtures difficiles : structure", () => {
  it("identifiants uniques, textes uniques et distincts des fixtures faciles", () => {
    expect(new Set(HARD_FIXTURES.map((x) => x.id)).size).toBe(HARD_FIXTURES.length);
    const texts = HARD_FIXTURES.map((x) => x.fr);
    expect(new Set(texts).size).toBe(texts.length);
    const easy = new Set(FIXTURES.map((x) => x.fr));
    expect(texts.filter((t) => easy.has(t))).toEqual([]);
  });

  it("intents dans le registre fermé ; abstention ⇒ intent, effet ET risque nuls (et réciproquement), sans lecture alternative", () => {
    for (const x of HARD_FIXTURES) {
      for (const r of readingsOf(x)) {
        if (r.intent === null) {
          expect(r.effect, x.id).toBeNull();
          expect(r.risk, x.id).toBeNull();
        } else {
          expect(INTENTS as readonly string[], x.id).toContain(r.intent);
          expect(typeof r.effect, x.id).toBe("boolean");
          expect([0, 1, 2], x.id).toContain(r.risk);
        }
      }
      if (x.intent === null) {
        expect(x.kind, x.id).toBe("underspecified");
        expect(x.alt, x.id).toBeUndefined();
      }
    }
  });

  it("un risque > 0 implique un effet ; une demande sans effet est en lecture seule (chaque lecture)", () => {
    for (const x of HARD_FIXTURES)
      for (const r of readingsOf(x)) {
        if (r.risk !== null && r.risk > 0) expect(r.effect, x.id).toBe(true);
        if (r.effect === false) expect(r.risk, x.id).toBe(0);
      }
  });

  it("la lecture alternative diffère de la principale", () => {
    for (const x of HARD_FIXTURES.filter((y) => y.alt)) expect(x.alt, x.id).not.toEqual({ intent: x.intent, effect: x.effect, risk: x.risk });
  });

  it("chaque famille a au moins 2 cas, chaque intent au moins 2, et il y a des cas à risque 2", () => {
    for (const k of KINDS) expect(HARD_FIXTURES.filter((x) => x.kind === k).length, k).toBeGreaterThanOrEqual(2);
    for (const i of INTENTS) expect(HARD_FIXTURES.filter((x) => x.intent === i).length, i).toBeGreaterThanOrEqual(2);
    expect(HARD_FIXTURES.filter((x) => x.risk === 2).length).toBeGreaterThanOrEqual(2);
  });

  it("questions conformes au contrat DecisionQuestion (choice, noul, score)", () => {
    for (const q of HARD_QUESTIONS) expect(DecisionQuestion.safeParse(q).success, q.id).toBe(true);
    expect(HARD_QUESTIONS.map((q) => q.type)).toEqual(["choice", "noul", "score"]);
  });
});

describe("Q16 fixtures difficiles : notation", () => {
  it("abstention : seul le triplet tout nul valide ; « aucun effet » ou « risque 0 » affirmés, ou toute réponse devinée, non", () => {
    const f = byId("under-1");
    expect(isCorrect(f, ans(null, null, null))).toBe(true);
    expect(isCorrect(f, ans(null, false, null))).toBe(false); // « pas d'effet » est déjà une affirmation sur une demande indécidable
    expect(isCorrect(f, ans(null, null, 0))).toBe(false); // idem « risque 0 »
    expect(isCorrect(f, ans(null, true, 2))).toBe(false);
    expect(isCorrect(f, ans("chat", null, null))).toBe(false);
    expect(isCorrect(f, ans("chat", false, 0))).toBe(false);
    expect(isCorrect(f, null)).toBe(false);
  });

  it("symétrie : sur les 8 combinaisons null / non null des trois champs, une seule est une abstention valide", () => {
    const f = byId("under-2");
    const vals = { intent: ["chat", null], effect: [false, null], risk: [0, null] } as const;
    const valid: string[] = [];
    for (const intent of vals.intent)
      for (const effect of vals.effect)
        for (const risk of vals.risk) {
          const a = ans(intent, effect, risk);
          if (isCorrect(f, a)) valid.push(JSON.stringify(a));
          expect(isAbstention(a), JSON.stringify(a)).toBe(intent === null && effect === null && risk === null);
        }
    expect(valid).toEqual([JSON.stringify(ans(null, null, null))]);
  });

  it("s'abstenir sur un cas décidable est faux, risque nul compris", () => {
    expect(isCorrect(byId("how-1"), ans(null, null, null))).toBe(false);
  });

  it("hors abstention, le risque n'entre pas dans le jugement (rapporté à part)", () => {
    const f = byId("sens-1"); // risque attendu 2
    expect(isCorrect(f, ans("action", true, 2))).toBe(true);
    expect(isCorrect(f, ans("action", true, 0))).toBe(true);
    expect(isCorrect(f, ans("action", true, null))).toBe(true);
  });

  it("double lecture : l'une ou l'autre, en entier ; jamais un mélange", () => {
    const f = byId("mix-1"); // action/vrai ou web/faux
    expect(isCorrect(f, ans("action", true, 1))).toBe(true);
    expect(isCorrect(f, ans("web", false, 0))).toBe(true);
    expect(isCorrect(f, ans("web", true, 1))).toBe(false);
    expect(isCorrect(f, ans("action", false, 0))).toBe(false);
    expect(isCorrect(f, ans("docs", false, 0))).toBe(false);
  });

  it("les cinq cas ambigus sont exactement neg-2, imp-4, mix-1, mix-4, sens-4", () => {
    expect(HARD_FIXTURES.filter((x) => x.alt).map((x) => x.id).sort()).toEqual(["imp-4", "mix-1", "mix-4", "neg-2", "sens-4"]);
  });

  it("cas à lecture unique : la seule réponse juste est la principale", () => {
    const f = byId("mix-2"); // envoi à l'extérieur : « docs » seul perdrait l'envoi
    expect(isCorrect(f, ans("action", true, 2))).toBe(true);
    expect(isCorrect(f, ans("docs", false, 0))).toBe(false);
  });

  it("score : réponses inutilisables comptées fausses ; repères intent/effet/risque séparés", () => {
    const answers = HARD_FIXTURES.map((f, i) => (i === 0 ? null : gold(f)));
    const s = scoreHard(HARD_FIXTURES, answers);
    expect(s.n).toBe(HARD_FIXTURES.length);
    expect(s.unusable).toBe(1);
    expect(s.correct).toBe(HARD_FIXTURES.length - 1);
    expect(s.intentOk).toBe(HARD_FIXTURES.length - 1);
    expect(s.riskOk).toBe(HARD_FIXTURES.length - 1);
    expect(s.abstentionExpected).toBe(HARD_FIXTURES.filter((f) => f.intent === null).length);
    expect(s.abstentionCorrect).toBe(s.abstentionExpected);
    expect(Object.values(s.byKind).reduce((a, k) => a + k.n, 0)).toBe(s.n);
    expect(() => scoreHard(HARD_FIXTURES, [])).toThrow();
  });

  it("une abstention hors cas attendu est comptée « rendue » mais pas juste", () => {
    const answers = HARD_FIXTURES.map((f) => (f.id === "how-1" ? ans(null, null, null) : gold(f)));
    const s = scoreHard(HARD_FIXTURES, answers);
    expect(s.correct).toBe(HARD_FIXTURES.length - 1);
    expect(s.abstained).toBe(s.abstentionExpected + 1);
    expect(s.abstentionCorrect).toBe(s.abstentionExpected);
  });
});

describe("Q16 fixtures difficiles : triage de la suite (< 40 % action ; 40–70 % investigation ; sinon rien)", () => {
  it("bornes en entiers sur 100", () => {
    expect(nextStep(39, 100)).toBe("action");
    expect(nextStep(40, 100)).toBe("investigation");
    expect(nextStep(70, 100)).toBe("investigation");
    expect(nextStep(71, 100)).toBe("rien");
    expect(nextStep(100, 100)).toBe("rien");
    expect(nextStep(0, 100)).toBe("action");
  });

  it(`sur les ${HARD_FIXTURES.length} fixtures : coupures exactes`, () => {
    const n = HARD_FIXTURES.length;
    const firstInvestigation = Array.from({ length: n + 1 }, (_, c) => c).find((c) => nextStep(c, n) === "investigation")!;
    const firstRien = Array.from({ length: n + 1 }, (_, c) => c).find((c) => nextStep(c, n) === "rien")!;
    expect(firstInvestigation * 100).toBeGreaterThanOrEqual(40 * n);
    expect((firstInvestigation - 1) * 100).toBeLessThan(40 * n);
    expect(firstRien * 100).toBeGreaterThan(70 * n);
    expect((firstRien - 1) * 100).toBeLessThanOrEqual(70 * n);
  });

  it("entrées invalides refusées", () => {
    expect(() => nextStep(1, 0)).toThrow();
    expect(() => nextStep(-1, 10)).toThrow();
    expect(() => nextStep(11, 10)).toThrow();
    expect(() => nextStep(1.5, 10)).toThrow();
  });
});
