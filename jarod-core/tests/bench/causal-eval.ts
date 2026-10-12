/**
 * SPECS-P5-CAUSAL.md §10 — machinerie de la mesure de la mémoire causale. Deux voies, mêmes requêtes, mêmes critères :
 *   - RÉFÉRENCE : plein texte FTS5 des messages bruts de l'apprentissage (ce que `sessions.search` rend déjà), sans porte ;
 *   - VOIE TESTÉE : plein texte FTS5 des ÉPISODES D'ÉCHEC avec texte (situation + action + texte d'échec ; échecs sans texte et réussites exclus de l'index,
 *     décision de l'utilisateur 2026-10-02), derrière une PORTE DE COUVERTURE (option B) : un échec classé dans les 3 premiers n'est PROPOSÉ que si au moins
 *     une fraction `c` des termes de la requête figure dans son texte. `c` est CALIBRÉ sur l'apprentissage seul puis figé (`calibrate`).
 * Requête d'une action = situation + action envisagée (jamais le résultat). Les constantes ci-dessous sont FIGÉES avant la mesure.
 */
import Database from "better-sqlite3-multiple-ciphers";
import { normalizeText } from "./causal-rules.js";
import type { CausalMeasure } from "./causal-verdict.js";

export const FROZEN = { topK: 3, maxQueryTokens: 64, situationChars: 500, actionChars: 300, indexMessageChars: 4000, actionKeyChars: 80 } as const;

export interface Episode {
  id: string;
  sessionId: string;
  tool: string | null;
  /** Dernier message de l'utilisateur avant l'appel (≤ 500 caractères). */
  situation: string;
  /** Outil + arguments (≤ 300 caractères). */
  action: string;
  kind: "succes" | "echec";
  /** Texte d'échec ("" pour une réussite ou un échec sans texte). */
  text: string;
  signature: string | null;
}

export interface RawMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  /** Si ce message est le résultat d'un échec QUALIFIÉ (texte non vide), l'épisode correspondant. */
  failureOf?: Episode;
}

/** Outil + valeurs des arguments (objet JSON) ou argument brut ; coupé à 300 caractères. */
export function actionText(tool: string | null, args: string): string {
  let body = args;
  try {
    const v = JSON.parse(args) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) body = Object.values(v as Record<string, unknown>).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  } catch {
    /* argument brut */
  }
  return `${tool ?? "?"}${body ? ` ${body}` : ""}`.slice(0, FROZEN.actionChars);
}

/** Tous les termes distincts d'un texte : minuscules, sans accents, 2 caractères et plus. */
export function tokenizeAll(s: string): string[] {
  const found = s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(found)];
}

/** Termes d'une requête : comme `tokenizeAll`, 64 au plus (dans l'ordre d'apparition). */
export const tokenize = (s: string): string[] => tokenizeAll(s).slice(0, FROZEN.maxQueryTokens);

/** OU de termes entre guillemets (rien de la syntaxe FTS5 n'est interprété) ; aucun terme → null. */
export const ftsQueryOf = (tokens: string[]): string | null => (tokens.length ? tokens.map((t) => `"${t}"`).join(" OR ") : null);

/** Clé d'une action : action normalisée (chemins, nombres neutralisés) sur 80 caractères. */
export const actionKey = (tool: string | null, args: string): string => normalizeText(actionText(tool, args)).slice(0, FROZEN.actionKeyChars);

/** Index plein texte en mémoire (FTS5, `unicode61 remove_diacritics 2`), classement bm25, égalités par ordre d'insertion. */
export class FtsIndex {
  private readonly db = new Database(":memory:");
  private readonly ids: string[] = [];
  private readonly insert;

  constructor() {
    this.db.exec("CREATE VIRTUAL TABLE d USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')");
    this.insert = this.db.prepare("INSERT INTO d (rowid, text) VALUES (?, ?)");
  }

  add(id: string, text: string): void {
    this.ids.push(id);
    this.insert.run(this.ids.length, text);
  }

  search(query: string | null, k: number): string[] {
    if (!query) return [];
    const rows = this.db.prepare("SELECT rowid FROM d WHERE d MATCH ? ORDER BY bm25(d), rowid LIMIT ?").all(query, k) as { rowid: number }[];
    return rows.map((r) => this.ids[r.rowid - 1]!);
  }

  close(): void {
    this.db.close();
  }
}

/** Cible = échec AVEC texte dont la signature a déjà été vue dans une AUTRE conversation d'apprentissage. */
export function isQualifiedTarget(e: Episode, trainFailuresBySignature: Map<string, Episode[]>): boolean {
  if (e.kind !== "echec" || e.text === "" || e.signature === null) return false;
  return (trainFailuresBySignature.get(e.signature) ?? []).some((t) => t.sessionId !== e.sessionId);
}

const queryTokensOf = (e: Episode): string[] => tokenize(`${e.situation.slice(0, FROZEN.situationChars)} ${e.action}`);
const episodeDoc = (e: Episode): string => `${e.situation.slice(0, FROZEN.situationChars)} ${e.action}${e.kind === "echec" ? ` ${e.text}` : ""}`;

/** Couverture d'une requête par un épisode : `num` termes de la requête présents dans l'épisode, sur `den` termes de la requête. */
export interface Coverage {
  num: number;
  den: number;
}

/** Comparaison EXACTE en entiers : num/den ≥ c % ; une absence de couverture (null) ne passe jamais. */
export const coveragePasses = (c: Coverage | null, percent: number): boolean => c !== null && c.num * 100 >= percent * c.den;
/** a > b pour deux couvertures non nulles. */
const better = (a: Coverage, b: Coverage | null): boolean => b === null || a.num * b.den > b.num * a.den;

export interface TargetRecord {
  tool: string;
  baselineHit: boolean;
  /** Meilleure couverture, parmi les 3 premiers, d'un échec de même signature d'une autre conversation ; null si aucun. */
  hitCoverage: Coverage | null;
}
export interface OffTargetRecord {
  /** Meilleure couverture parmi les échecs des 3 premiers ; null si la voie testée ne rend aucun échec. */
  maxCoverage: Coverage | null;
  baselineAlarm: boolean;
}
export interface Records {
  targets: TargetRecord[];
  offTargets: OffTargetRecord[];
}

export interface MeasureDetails {
  trainEpisodes: number;
  indexedEpisodes: number;
  trainMessages: number;
  testEpisodes: number;
  testFailures: number;
  unqualified: number;
  targets: number;
  offTargets: number;
}

/** `mixed` : l'index contient réussites ET échecs (une réussite proche prend la place d'un échec) ; `failures` : seulement les échecs avec texte (choisi). */
export type IndexMode = "mixed" | "failures";

export function collectRecords(input: { train: Episode[]; test: Episode[]; trainMessages: RawMessage[]; indexMode?: IndexMode }): { records: Records; details: MeasureDetails } {
  const { train, test, trainMessages } = input;
  const indexed = train.filter((e) => (e.kind === "succes" && input.indexMode === "mixed") || (e.kind === "echec" && e.text !== ""));
  const byId = new Map(indexed.map((e) => [e.id, e]));
  const docTokens = new Map<string, Set<string>>();
  const system = new FtsIndex();
  for (const e of indexed) system.add(e.id, episodeDoc(e));
  const baseline = new FtsIndex();
  const msgById = new Map(trainMessages.map((m) => [m.id, m]));
  for (const m of trainMessages) baseline.add(m.id, m.content.slice(0, FROZEN.indexMessageChars));

  const failuresBySig = new Map<string, Episode[]>();
  const failureActionKeys = new Set<string>();
  for (const e of train) {
    if (e.kind === "echec" && e.text !== "" && e.signature) failuresBySig.set(e.signature, [...(failuresBySig.get(e.signature) ?? []), e]);
    if (e.kind === "echec" && e.text !== "") failureActionKeys.add(normalizeText(e.action).slice(0, FROZEN.actionKeyChars));
  }
  const coverageOf = (q: string[], d: Episode): Coverage => {
    let tokens = docTokens.get(d.id);
    if (!tokens) docTokens.set(d.id, (tokens = new Set(tokenizeAll(episodeDoc(d)))));
    return { num: q.filter((t) => tokens!.has(t)).length, den: q.length };
  };

  const records: Records = { targets: [], offTargets: [] };
  let testFailures = 0;
  let unqualified = 0;
  for (const e of test) {
    const qTokens = queryTokensOf(e);
    const q = ftsQueryOf(qTokens);
    if (e.kind === "echec") {
      testFailures++;
      if (!isQualifiedTarget(e, failuresBySig)) {
        unqualified++;
        continue;
      }
      let hit: Coverage | null = null;
      for (const id of system.search(q, FROZEN.topK)) {
        const d = byId.get(id)!;
        if (d.kind !== "echec" || d.signature !== e.signature || d.sessionId === e.sessionId) continue;
        const c = coverageOf(qTokens, d);
        if (better(c, hit)) hit = c;
      }
      const baselineHit = baseline.search(q, FROZEN.topK).some((id) => {
        const f = msgById.get(id)!.failureOf;
        return f !== undefined && f.signature === e.signature && f.sessionId !== e.sessionId;
      });
      records.targets.push({ tool: e.tool ?? "?", baselineHit, hitCoverage: hit });
    } else {
      // Hors cible : réussite dont l'action (même clé normalisée) n'a JAMAIS échoué avec texte dans l'apprentissage.
      if (failureActionKeys.has(normalizeText(e.action).slice(0, FROZEN.actionKeyChars))) continue;
      let maxCoverage: Coverage | null = null;
      for (const id of system.search(q, FROZEN.topK)) {
        const d = byId.get(id)!;
        if (d.kind !== "echec") continue;
        const c = coverageOf(qTokens, d);
        if (better(c, maxCoverage)) maxCoverage = c;
      }
      const baselineAlarm = baseline.search(q, FROZEN.topK).some((id) => msgById.get(id)!.failureOf !== undefined);
      records.offTargets.push({ maxCoverage, baselineAlarm });
    }
  }
  system.close();
  baseline.close();
  return {
    records,
    details: {
      trainEpisodes: train.length,
      indexedEpisodes: indexed.length,
      trainMessages: trainMessages.length,
      testEpisodes: test.length,
      testFailures,
      unqualified,
      targets: records.targets.length,
      offTargets: records.offTargets.length,
    },
  };
}

/** Résultat de la voie testée derrière une porte de couverture de `percent` % (0 = aucune porte). */
export function measureAt(records: Records, percent: number): CausalMeasure {
  return {
    targets: records.targets.length,
    baselineHits: records.targets.filter((t) => t.baselineHit).length,
    systemHits: records.targets.filter((t) => coveragePasses(t.hitCoverage, percent)).length,
    offTargets: records.offTargets.length,
    falseAlarms: records.offTargets.filter((o) => coveragePasses(o.maxCoverage, percent)).length,
  };
}

export interface CurvePoint {
  c: number;
  hits: number;
  recallPercent: number;
  falseAlarms: number;
  precisionPercent: number;
}

/**
 * Calibration de la porte : courbe pour c = 0…100 % (pas de 1) et PLUS PETIT c dont la précision hors cibles atteint `precisionTargetPercent` (comparaison
 * entière). La précision ne décroît jamais quand c augmente : le plus petit c qui convient est aussi celui qui garde le plus de rappel. Rien d'atteignable
 * (ou aucune action hors cible) → `chosenPercent: null`.
 */
export function calibrate(records: Records, precisionTargetPercent: number): { chosenPercent: number | null; curve: CurvePoint[] } {
  const off = records.offTargets.length;
  const curve: CurvePoint[] = [];
  let chosen: number | null = null;
  for (let c = 0; c <= 100; c++) {
    const m = measureAt(records, c);
    const round2 = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 10000) / 100);
    curve.push({ c, hits: m.systemHits, recallPercent: round2(m.systemHits, m.targets), falseAlarms: m.falseAlarms, precisionPercent: round2(off - m.falseAlarms, off) });
    if (chosen === null && off > 0 && 100 * (off - m.falseAlarms) >= precisionTargetPercent * off) chosen = c;
  }
  return { chosenPercent: chosen, curve };
}

/** Mesure sans porte (c = 0) : même chemin que la collecte, utilisé par le canari et le contrôle de fidélité. */
export function runMeasure(input: { train: Episode[]; test: Episode[]; trainMessages: RawMessage[]; indexMode?: IndexMode }): { measure: CausalMeasure; details: MeasureDetails } {
  const { records, details } = collectRecords({ ...input, indexMode: input.indexMode ?? "mixed" });
  return { measure: measureAt(records, 0), details };
}
