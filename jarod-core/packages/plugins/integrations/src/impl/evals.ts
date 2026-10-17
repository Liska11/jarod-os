/**
 * A5 (promptfoo) — suite d'évaluation comportementale.
 *
 * Les campagnes tournent dans la sandbox dédiée seulement : `runSuite` exige `sandboxed: true` (l'appelant l'affirme après
 * avoir créé un dossier jeton), sinon il refuse. Un cas échoue si une assertion échoue ; un modèle qui lève une erreur
 * fait échouer le cas (jamais « réussi par défaut »). `toPromptfooConfig` exporte la suite au format promptfoo pour
 * l'outil officiel quand il sera installé (action humaine).
 */
import { AdapterRefused } from "./common.js";

export type Assertion =
  | { type: "contains"; value: string }
  | { type: "not-contains"; value: string }
  | { type: "regex"; value: string }
  | { type: "max-length"; value: number }
  | { type: "tool-not-called"; value: string }
  | { type: "tool-called"; value: string };

export interface EvalCase {
  id: string;
  input: string;
  expect: Assertion[];
}

export interface EvalSuite {
  id: string;
  cases: EvalCase[];
}

export interface Answer {
  text: string;
  toolCalls: string[];
}

export interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
}

export interface SuiteReport {
  suite: string;
  total: number;
  passed: number;
  passRate: number;
  cases: CaseResult[];
}

function check(a: Assertion, r: Answer): string | null {
  switch (a.type) {
    case "contains":
      return r.text.includes(a.value) ? null : `absent : « ${a.value} »`;
    case "not-contains":
      return r.text.includes(a.value) ? `présent : « ${a.value} »` : null;
    case "regex":
      return new RegExp(a.value, "i").test(r.text) ? null : `ne correspond pas : /${a.value}/`;
    case "max-length":
      return r.text.length <= a.value ? null : `trop long : ${r.text.length} > ${a.value}`;
    case "tool-not-called":
      return r.toolCalls.includes(a.value) ? `outil appelé : ${a.value}` : null;
    case "tool-called":
      return r.toolCalls.includes(a.value) ? null : `outil non appelé : ${a.value}`;
  }
}

export async function runSuite(suite: EvalSuite, ctx: { ask(input: string): Promise<Answer>; sandboxed: boolean }): Promise<SuiteReport> {
  if (ctx.sandboxed !== true) throw new AdapterRefused("A5", "une campagne d'évaluation ne tourne que dans la sandbox dédiée");
  if (!suite.cases.length) throw new AdapterRefused("A5", "suite sans cas");
  const cases: CaseResult[] = [];
  for (const c of suite.cases) {
    if (!c.expect.length) {
      cases.push({ id: c.id, passed: false, failures: ["aucune assertion : un cas sans assertion ne prouve rien"] });
      continue;
    }
    try {
      const answer = await ctx.ask(c.input);
      const failures = c.expect.map((a) => check(a, answer)).filter((x): x is string => x !== null);
      cases.push({ id: c.id, passed: failures.length === 0, failures });
    } catch (e) {
      cases.push({ id: c.id, passed: false, failures: [`erreur : ${(e as Error).message.slice(0, 200)}`] });
    }
  }
  const passed = cases.filter((c) => c.passed).length;
  return { suite: suite.id, total: cases.length, passed, passRate: passed / cases.length, cases };
}

/** Export au format de configuration promptfoo (JSON, accepté par `promptfoo eval -c`). */
export function toPromptfooConfig(suite: EvalSuite): string {
  const assertMap = (a: Assertion) => {
    switch (a.type) {
      case "contains":
        return { type: "contains", value: a.value };
      case "not-contains":
        return { type: "not-contains", value: a.value };
      case "regex":
        return { type: "regex", value: a.value };
      case "max-length":
        return { type: "javascript", value: `output.length <= ${Number(a.value)}` };
      case "tool-not-called":
        return { type: "not-contains", value: a.value, metric: "tool-not-called" };
      case "tool-called":
        return { type: "contains", value: a.value, metric: "tool-called" };
    }
  };
  return JSON.stringify(
    { description: suite.id, prompts: ["{{input}}"], tests: suite.cases.map((c) => ({ description: c.id, vars: { input: c.input }, assert: c.expect.map(assertMap) })) },
    null,
    2,
  );
}
