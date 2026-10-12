/**
 * LEÇON du 2026-10-02 (DECISIONS « rag.hybrid V1 : barre (f) hors échantillon MANQUÉE ») : la barre (d) installait un calculateur d'embeddings figé
 * (`setEmbedder`) que rien ne retirait ; la barre (f), lancée ensuite, donnait un dense à 1/15 sans que rien ne le dise. RÈGLE : un banc VÉRIFIE
 * son état au départ de CHAQUE barre — il remet à zéro ce qu'une barre précédente a pu laisser (calculateur de test, drapeau) et prouve que la chaîne
 * réelle répond comme attendu avec une requête-canari dont la réponse est connue. Un état invalide arrête le banc (jamais un chiffre faux).
 */
export interface StateRag {
  search(q: string, k?: number): Promise<{ docId: string; ord: number }[]>;
  setEmbedder(f: null): void;
}

export interface Canary {
  /** Requête dont la réponse est connue d'avance (un extrait verbatim d'un passage indexé). */
  text: string;
  /** Clés `document#ordre` acceptées au rang 1. */
  ok: ReadonlySet<string>;
}

export class BenchStateError extends Error {
  constructor(label: string, detail: string) {
    super(`${label} : état du banc invalide — ${detail}`);
    this.name = "BenchStateError";
  }
}

/** À appeler en TÊTE de chaque barre : retire le calculateur de test, éteint le drapeau, puis vérifie la chaîne réelle avec le canari. */
export async function resetBenchState(label: string, o: { rag: StateRag; setFlag(v: "on" | "off"): void; canary: Canary }): Promise<void> {
  o.rag.setEmbedder(null);
  o.setFlag("off");
  const hits = await o.rag.search(o.canary.text, 5);
  const top = hits[0] ? `${hits[0].docId}#${hits[0].ord}` : null;
  if (top === null || !o.canary.ok.has(top)) {
    throw new BenchStateError(label, `la requête-canari ne ramène pas son passage au rang 1 (obtenu : ${top ?? "rien"}) — un calculateur d'embeddings de test est resté actif, ou la chaîne ne répond pas comme attendue`);
  }
}
