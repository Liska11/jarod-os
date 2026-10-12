// Portage de packages/core/src/services/routing.ts (rév. 2e180305).
export interface Candidate {
  provider: string;
  model: string;
  /** Un coût relatif déclaré, utilisé seulement par la stratégie « cheapest ». */
  cost?: number;
}

export interface Breaker {
  key: string;
  failures: number;
  /** Instant jusqu'auquel ce candidat est écarté. 0 = disponible. */
  downUntil: number;
  /** Latence lissée, en millisecondes, ou null tant qu'on n'a rien mesuré. */
  latencyMs: number | null;
}

export type Strategy = "order" | "fastest" | "cheapest";

/** Trois échecs suffisent : au-delà, on continue de frapper une porte fermée. */
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Le choix du modèle, et ce qu'on fait quand il ne répond pas.
 *
 * Aujourd'hui, quinze fournisseurs sont proposés et aucun n'a de politique : la panne d'un seul
 * produit une erreur au lieu d'un basculement vers un équivalent. Ce service tient trois choses.
 *
 * Un disjoncteur : après trois échecs, le candidat est écarté soixante secondes. Sans lui, une
 * panne coûte un délai d'attente à chaque tentative, et chaque tentative rapproche l'utilisateur
 * d'abandonner sa journée. Un succès remet le compteur à zéro : la santé se regagne.
 *
 * Un classement : par ordre déclaré, par latence **mesurée** (moyenne lissée, pas une promesse de
 * fiche technique), ou par coût déclaré.
 *
 * Et une règle : quand **tous** les candidats sont écartés, on les rend quand même, du prochain à
 * se rétablir au dernier. Un disjoncteur qui refuse de parler n'est pas un disjoncteur, c'est une
 * panne de plus — mieux vaut essayer et échouer en le disant.
 */
export class RoutingService {
  private readonly breakers = new Map<string, Breaker>();

  constructor(
    private readonly d: {
      now?: () => number;
      failureThreshold?: number;
      cooldownMs?: number;
      /** Le poids de la dernière mesure dans la latence lissée. */
      smoothing?: number;
    } = {},
  ) {}

  private at(): number {
    return this.d.now?.() ?? Date.now();
  }

  private key(candidate: Candidate): string {
    return `${candidate.provider}:${candidate.model}`;
  }

  breaker(candidate: Candidate): Breaker {
    const key = this.key(candidate);
    let found = this.breakers.get(key);
    if (!found) {
      found = { key, failures: 0, downUntil: 0, latencyMs: null };
      this.breakers.set(key, found);
    }
    return found;
  }

  isDown(candidate: Candidate): boolean {
    const breaker = this.breaker(candidate);
    if (breaker.downUntil === 0) return false;
    if (this.at() >= breaker.downUntil) {
      // Fin du délai : on lui redonne sa chance, et on efface les échecs qui l'ont mis là. Sinon un
      // seul échec après la reprise le renverrait au tapis, et le disjoncteur ne se rouvrirait jamais.
      breaker.downUntil = 0;
      breaker.failures = 0;
      return false;
    }
    return true;
  }

  /** Note une tentative. Un succès efface le compteur ; un échec au seuil ouvre le disjoncteur. */
  record(candidate: Candidate, outcome: { ok: boolean; ms?: number }): Breaker {
    const breaker = this.breaker(candidate);
    if (outcome.ok) {
      breaker.failures = 0;
      breaker.downUntil = 0;
      if (typeof outcome.ms === "number") {
        const weight = this.d.smoothing ?? 0.3;
        breaker.latencyMs =
          breaker.latencyMs === null ? outcome.ms : Math.round(breaker.latencyMs * (1 - weight) + outcome.ms * weight);
      }
      return breaker;
    }
    breaker.failures += 1;
    if (breaker.failures >= (this.d.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)) {
      breaker.downUntil = this.at() + (this.d.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    }
    return breaker;
  }

  /** La chaîne à essayer, dans l'ordre. Les écartés passent derrière, jamais dehors. */
  order(candidates: Candidate[], strategy: Strategy = "order"): Candidate[] {
    // Une seule décision par candidat, mémorisée : `isDown` remet l'état à zéro quand le délai vient
    // d'expirer (voir plus haut), donc deux appels successifs peuvent répondre deux choses
    // différentes. Un candidat dont le refroidissement expirait entre les deux passes était alors
    // écarté des disponibles puis rétabli dans les écartés : il ne sortait dans aucune des deux
    // listes, et la chaîne le perdait — alors qu'un écarté doit passer derrière, jamais dehors.
    const verdicts = candidates.map((candidate) => ({ candidate, down: this.isDown(candidate) }));
    const available = verdicts.filter((verdict) => !verdict.down).map((verdict) => verdict.candidate);
    const down = verdicts.filter((verdict) => verdict.down).map((verdict) => verdict.candidate);
    const sort = (list: Candidate[]): Candidate[] => {
      if (strategy === "fastest") {
        return [...list].sort((a, b) => rank(a, b, this, "latencyMs"));
      }
      if (strategy === "cheapest") {
        return [...list].sort((a, b) => (a.cost ?? Number.MAX_SAFE_INTEGER) - (b.cost ?? Number.MAX_SAFE_INTEGER));
      }
      return list;
    };
    // Écartés : du prochain à se rétablir au dernier, puisqu'on les rend quand même.
    const recovering = [...down].sort((a, b) => this.breaker(a).downUntil - this.breaker(b).downUntil);
    return [...sort(available), ...recovering];
  }

  /** L'état, pour un diagnostic lisible plutôt qu'un journal technique. */
  state(): Breaker[] {
    return [...this.breakers.values()].map((breaker) => ({ ...breaker }));
  }

  reset(): void {
    this.breakers.clear();
  }
}

function rank(a: Candidate, b: Candidate, service: RoutingService, field: "latencyMs"): number {
  const left = service.breaker(a)[field];
  const right = service.breaker(b)[field];
  // Un candidat jamais mesuré passe devant : on ne peut pas le classer, et le tester coûte une
  // tentative — l'écarter d'office reviendrait à ne jamais essayer un modèle neuf.
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left - right;
}
