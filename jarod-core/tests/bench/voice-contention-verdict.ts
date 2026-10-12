/**
 * Verdict de la contention « ingestion de documents → voix », protocole et barres FIGÉS le 2026-10-01 AVANT toute mesure
 * (DECISIONS). Pur : aucune E/S.
 *
 * A = voice.e2e à vide, B = voice.e2e pendant une ingestion continue, en alternance stricte.
 * « Pas de dégradation démontrée » n'est PAS « absence de dégradation » : avec ~30 passages par condition, le test n'en voit
 * qu'une marquée. Les effectifs et les comptes sont toujours rapportés.
 */

export const ALPHA = 0.05;
export const MAX_LATENCY_RATIO = 1.1;
export const MIN_BASE_SUCCESS = 0.5;
export const MIN_LOAD_SHARE = 0.9;

export type Outcome = "OK" | "CRASH" | "FAIL";

export interface Pass {
  condition: "A" | "B";
  outcome: Outcome;
  /** Condition B : documents indexés PENDANT le passage. */
  docsDuring?: number;
  /** Charge DANS l'application avec priorité : temps total cédé à la voix pendant le passage (ms) ; absent = non mesuré. */
  pausedMs?: number;
  /** Affectation des formes d'embedding aux appareils pendant ce passage (JSON, clés triées) ; condition B / témoin. */
  embDevices?: string;
  /** Passages OK seulement : transcription (ms) et délai du mot d'activation (ms). */
  sttMs?: number;
  wakeAtMs?: number;
}

export interface Verdict {
  verdict: "dégradation" | "pas de dégradation démontrée" | "invalide";
  n: { A: number; B: number };
  ok: { A: number; B: number };
  crash: { A: number; B: number };
  fisherP: number;
  medians: { sttA: number | null; sttB: number | null; wakeA: number | null; wakeB: number | null };
  reasons: string[];
}

const lnFact = (() => {
  const cache = [0];
  return (n: number): number => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1]! + Math.log(i);
    return cache[n]!;
  };
})();
const lnChoose = (n: number, k: number) => lnFact(n) - lnFact(k) - lnFact(n - k);

/**
 * Test exact de Fisher unilatéral : probabilité, sous H0 (même taux de réussite), d'observer AU PLUS `okB` réussites en B,
 * connaissant les marges (nA, nB, totalOk). Petit p = B réussit moins qu'A.
 */
export function fisherLess(okA: number, nA: number, okB: number, nB: number): number {
  const totalOk = okA + okB;
  const n = nA + nB;
  let p = 0;
  for (let x = Math.max(0, totalOk - nA); x <= Math.min(okB, totalOk, nB); x++) {
    p += Math.exp(lnChoose(nB, x) + lnChoose(nA, totalOk - x) - lnChoose(n, totalOk));
  }
  return Math.min(1, p);
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

export interface VerdictOptions {
  /** SPECS-P5-VOIX-PRIORITAIRE.md §7 : exige la preuve que le mécanisme s'est enclenché (`pausedMs` > 0) dans ≥ 90 % des passages B. */
  requirePause?: boolean;
  /** Affectation attendue des formes d'embedding (la contention en dépend : 128 sur l'iGPU = +79 %, 512 sur l'iGPU = +9,5 %) ; ≥ 90 % des passages B doivent la porter. */
  expectedDevices?: string;
}

export function voiceContentionVerdict(passes: readonly Pass[], opts: VerdictOptions = {}): Verdict {
  const A = passes.filter((p) => p.condition === "A");
  const B = passes.filter((p) => p.condition === "B");
  const okA = A.filter((p) => p.outcome === "OK");
  const okB = B.filter((p) => p.outcome === "OK");
  const crash = { A: A.filter((p) => p.outcome === "CRASH").length, B: B.filter((p) => p.outcome === "CRASH").length };
  const fisherP = A.length && B.length ? fisherLess(okA.length, A.length, okB.length, B.length) : 1;
  const med = (xs: Pass[], k: "sttMs" | "wakeAtMs") => median(xs.map((p) => p[k]).filter((v): v is number => typeof v === "number"));
  const medians = { sttA: med(okA, "sttMs"), sttB: med(okB, "sttMs"), wakeA: med(okA, "wakeAtMs"), wakeB: med(okB, "wakeAtMs") };

  const invalid: string[] = [];
  if (!A.length || !B.length) invalid.push("une condition est vide");
  if (A.length && okA.length / A.length < MIN_BASE_SUCCESS) invalid.push(`réussite à vide ${okA.length}/${A.length} < ${MIN_BASE_SUCCESS * 100} % : machine instable`);
  if (B.length && B.filter((p) => (p.docsDuring ?? 0) >= 1).length / B.length < MIN_LOAD_SHARE) invalid.push("la charge n'a pas tourné pendant au moins 90 % des passages B");

  if (opts.requirePause && B.length && B.filter((p) => (p.pausedMs ?? 0) > 0).length / B.length < MIN_LOAD_SHARE) invalid.push("le mécanisme de priorité ne s'est pas enclenché (pausedMs > 0) dans au moins 90 % des passages B");
  if (opts.expectedDevices && B.length && B.filter((p) => p.embDevices === opts.expectedDevices).length / B.length < MIN_LOAD_SHARE) invalid.push(`l'affectation des appareils d'embedding n'est pas ${opts.expectedDevices} dans au moins 90 % des passages B`);

  const reasons: string[] = [];
  if (A.length && B.length && okB.length / B.length < okA.length / A.length && fisherP < ALPHA) reasons.push(`réussite ${okB.length}/${B.length} sous charge contre ${okA.length}/${A.length} à vide (Fisher unilatéral p = ${fisherP.toFixed(3)} < ${ALPHA})`);
  const slow = (b: number | null, a: number | null, label: string) => {
    if (a !== null && b !== null && b > a * MAX_LATENCY_RATIO) reasons.push(`${label} : médiane ${b.toFixed(0)} ms sous charge contre ${a.toFixed(0)} ms à vide (> ${MAX_LATENCY_RATIO}×)`);
  };
  slow(medians.sttB, medians.sttA, "transcription");
  slow(medians.wakeB, medians.wakeA, "mot d'activation");

  // Une mesure invalide (base instable, charge absente) prime : on ne conclut ni à une dégradation ni à son absence.
  const verdict = invalid.length ? "invalide" : reasons.length ? "dégradation" : "pas de dégradation démontrée";
  return { verdict, n: { A: A.length, B: B.length }, ok: { A: okA.length, B: okB.length }, crash, fisherP, medians, reasons: invalid.length ? invalid : reasons };
}
