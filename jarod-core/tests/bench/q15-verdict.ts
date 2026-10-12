/**
 * Verdict d'adoption Q15, critère figé le 2026-09-28 AVANT les chiffres à 10⁴/10⁵ (DECISIONS « Q15 — accord
 * B17, sidecar et protocole de bench ») : un moteur turbovec gagne SEULEMENT si, à 10⁴ ET à 10⁵, contre
 * `memory` ET contre `int8` :
 *   - p95 de bout en bout (stdio compris) plus bas ;
 *   - RAM de l'index (delta mesuré du processus) plus basse ;
 *   - rappel à cible connue @3 au moins égal à celui de `memory` ;
 *   - P2 (24 documents de la gate P2, trouvés @3) au moins égal à la recherche exacte (`memory`).
 * Clause P2 AMENDÉE le 2026-09-29 par décision utilisateur, après le bench et avant toute adoption : la
 * clause d'origine « P2 24/24 » était insatisfaisable à 10⁵ — la recherche exacte elle-même n'y trouve que
 * 22/24 (whisper rang 11, cron rang 20, éclipsés par de vrais chunks du dépôt). DECISIONS 2026-09-29.
 * Le rappel@10 contre la recherche exacte est relevé sans seuil. Une taille absente = verdict « incomplet »,
 * jamais une victoire.
 */

export const VERDICT_SIZES = [10_000, 100_000] as const;
export const BASELINES = ["memory", "int8"] as const;

export interface VerdictRun {
  engine: string;
  size: number;
  p95Ms: number;
  ramMb: number;
  at3: number;
  p2At3: number;
  p2: number;
}

export interface Verdict {
  engine: string;
  verdict: "gagné" | "perdu" | "incomplet";
  /** Chaque condition manquée, en clair (vide si gagné). */
  reasons: string[];
}

export function q15Verdict(engine: string, runs: readonly VerdictRun[]): Verdict {
  const reasons: string[] = [];
  let missing = false;
  for (const size of VERDICT_SIZES) {
    const at = (e: string) => runs.find((r) => r.engine === e && r.size === size);
    const cand = at(engine);
    const bases = BASELINES.map((b) => [b, at(b)] as const);
    if (!cand || bases.some(([, r]) => !r)) {
      missing = true;
      reasons.push(`${size} : mesure absente`);
      continue;
    }
    for (const [name, base] of bases) {
      if (!(cand.p95Ms < base!.p95Ms)) reasons.push(`${size} : p95 ${cand.p95Ms} ms ≥ ${name} ${base!.p95Ms} ms`);
      if (!(cand.ramMb < base!.ramMb)) reasons.push(`${size} : RAM ${cand.ramMb} Mo ≥ ${name} ${base!.ramMb} Mo`);
    }
    const mem = at("memory")!;
    if (cand.at3 < mem.at3) reasons.push(`${size} : rappel@3 ${cand.at3} < memory ${mem.at3}`);
    if (cand.p2At3 < mem.p2At3) reasons.push(`${size} : P2 ${cand.p2At3}/${cand.p2} < exacte ${mem.p2At3}/${mem.p2}`);
  }
  const lost = reasons.some((r) => !r.endsWith("mesure absente"));
  return { engine, verdict: lost ? "perdu" : missing ? "incomplet" : "gagné", reasons };
}
