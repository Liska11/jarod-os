/**
 * Index vectoriel en mémoire pour `RagService.search` (gap G2, PLAN §3). Jarod-cordis — nouveau.
 *
 * Mesure avant optimisation (base chiffrée, dim 1024, `tests/bench/rag-p95.test.ts`) : le balayage
 * complet de `rag.ts` relisait, déchiffrait et désérialisait TOUTES les lignes à chaque requête —
 * p95 4,4 ms à 10³ chunks, 195,6 ms à 10⁴, 1 630 ms à 10⁵.
 *
 * Ici les vecteurs sont chargés une fois dans une matrice contiguë (normes précalculées) et rechargés
 * seulement quand l'index change : écriture par `RagService` (invalidation explicite) ou par un autre
 * processus sur la même base (signature `count(*)`/`max(id)` de `rag_chunks`, relue à chaque requête).
 * Le score reste EXACTEMENT le cosinus de `rag.ts` (même formule, mêmes lignes, même ordre de lecture),
 * donc les résultats sont identiques au balayage. Aucun changement de schéma.
 *
 * Coût mémoire : 4 octets × dim × chunks (40 Mo pour 10⁴ chunks en dim 1024).
 */
import type { Db } from "@jarod/plugin-storage";
import { blobToFloats } from "./rag.js";

export interface IndexedChunk {
  docId: string;
  ord: number;
  text: string;
  source: string | null;
}

interface Row {
  doc_id: string;
  ord: number;
  text: string;
  dim: number;
  embedding: Buffer;
  source: string | null;
}

export class VectorIndex {
  private signature = "";
  private dirty = true;
  private dim = 0;
  private chunks: IndexedChunk[] = [];
  private matrix = new Float32Array(0);
  private norms = new Float64Array(0);

  constructor(private readonly db: Db) {}

  /** À appeler après toute écriture dans `rag_chunks` faite par ce processus. */
  invalidate(): void {
    this.dirty = true;
  }

  private currentSignature(): string {
    const r = this.db.get<{ n: number; m: number | null }>("SELECT count(*) AS n, max(id) AS m FROM rag_chunks");
    return `${r?.n ?? 0}:${r?.m ?? 0}`;
  }

  private load(): void {
    const sig = this.currentSignature();
    if (!this.dirty && sig === this.signature) return;
    // Même requête que le balayage de rag.ts (même ordre de lecture, donc mêmes égalités de score).
    const rows = this.db.all<Row>("SELECT doc_id, ord, text, dim, embedding, source FROM rag_chunks");
    const dim = rows[0]?.dim ?? 0;
    // M8 : des dimensions MÉLANGÉES (réindexation interrompue, modèle d'embeddings changé) étaient tronquées
    // ou complétées de ZÉROS en silence (`subarray(0, dim)` / `set` plus court que la ligne) : la recherche
    // rendait des scores faux sans rien dire. On refuse, avec la même erreur et le même remède que `ranked()`.
    const mixed = rows.find((r) => r.dim !== dim);
    if (mixed)
      throw new Error(
        `RAG_DIM_MISMATCH: index en dimensions mélangées (${dim} et ${mixed.dim}, document « ${mixed.doc_id} »). ` +
          "Réindexez avant de chercher.",
      );
    const matrix = new Float32Array(rows.length * dim);
    const norms = new Float64Array(rows.length);
    const chunks: IndexedChunk[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const v = blobToFloats(r.embedding);
      // Le vecteur stocké doit porter EXACTEMENT la dimension annoncée : une ligne corrompue se dit.
      if (v.length !== dim)
        throw new Error(
          `RAG_DIM_MISMATCH: le passage ${r.ord} de « ${r.doc_id} » porte ${v.length} dimensions pour un index en ${dim}. ` +
            "Réindexez avant de chercher.",
        );
      matrix.set(v, i * dim);
      let n = 0;
      for (let k = 0; k < v.length; k++) n += v[k]! * v[k]!;
      norms[i] = Math.sqrt(n);
      chunks[i] = { docId: r.doc_id, ord: r.ord, text: r.text, source: r.source };
    }
    this.dim = dim;
    this.chunks = chunks;
    this.matrix = matrix;
    this.norms = norms;
    this.signature = sig;
    this.dirty = false;
  }

  /** Nombre de chunks et dimension indexés (après rechargement si besoin). */
  stats(): { size: number; dim: number } {
    this.load();
    return { size: this.chunks.length, dim: this.dim };
  }

  /**
   * Tous les chunks triés par cosinus décroissant (tri stable : l'ordre de lecture départage).
   * Le cosinus est celui de `rag.ts:107` : dot / (|a|·|b|), 0 si une norme est nulle.
   */
  ranked(query: Float32Array): (IndexedChunk & { score: number })[] {
    this.load();
    const n = this.chunks.length;
    if (n === 0) return [];
    if (query.length !== this.dim) {
      throw new Error(
        `RAG_DIM_MISMATCH: index en ${this.dim} dimensions, requête en ${query.length}. ` +
          "Le modèle d'embeddings a changé : réindexez avant de chercher.",
      );
    }
    let qn = 0;
    for (let k = 0; k < this.dim; k++) qn += query[k]! * query[k]!;
    qn = Math.sqrt(qn);
    const scores = new Float64Array(n);
    const m = this.matrix;
    const d = this.dim;
    for (let i = 0; i < n; i++) {
      let dot = 0;
      const base = i * d;
      for (let k = 0; k < d; k++) dot += query[k]! * m[base + k]!;
      const denom = qn * this.norms[i]!;
      scores[i] = denom === 0 ? 0 : dot / denom;
    }
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((a, b) => scores[b]! - scores[a]!);
    return order.map((i) => ({ ...this.chunks[i]!, score: scores[i]! }));
  }
}
