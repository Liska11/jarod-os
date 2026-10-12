/**
 * Mode FANTÔME de l'index vectoriel (PLAN §10 phase 1 ; Q15, DECISIONS 2026-09-29). Jarod-cordis — nouveau.
 *
 * Quand le profil pose `ecosystem.vectorShadow`, chaque recherche RAG est rejouée sur le moteur candidat
 * APRÈS que la réponse est calculée : le fantôme ne change ni les résultats, ni leur ordre, ni la latence
 * rendue (appel non attendu, une comparaison à la fois, les suivantes sont comptées puis ignorées tant
 * qu'une est en cours). Il compare son top-k au top-k servi (avant le plafond par document) et tient des
 * compteurs : recouvrement@k, même premier résultat, latence, erreurs par code. Rien de textuel n'est
 * gardé ni journalisé (codes et nombres seulement, règle des contrats).
 *
 * Synchronisation : `rag_chunks.id` est AUTOINCREMENT, jamais réutilisé — une ré-ingestion supprime puis
 * réinsère, donc de nouveaux ids. Le fantôme compare les ids de SQLite aux siens quand la signature
 * `count(*)`/`max(id)` change : il retire les disparus, ajoute les nouveaux. Premier usage, ou dimension
 * changée : reconstruction complète depuis SQLite (≈ 1,1 s à 10⁵ chunks au bench Q15).
 *
 * Toute erreur du moteur DÉGRADE : compteur par code, la recherche servie n'en voit rien. Un moteur
 * indisponible (sidecar absent ou mort) arrête le fantôme jusqu'au redémarrage.
 */
import type { EngineInfo, IndexSpec, VectorIndexKind, VectorIndexProvider, VectorRow } from "@jarod/contracts";
import type { Db } from "@jarod/plugin-storage";
import { blobToFloats } from "./rag.js";

/** Fournisseur fantôme : le contrat, plus de quoi savoir s'il peut servir. */
export type ShadowProvider = VectorIndexProvider & { readonly available: boolean };

export interface ShadowReport {
  engine: EngineInfo;
  /** `degraded` : fantôme arrêté (moteur indisponible) ; les erreurs ponctuelles sont dans `errors`. */
  state: "idle" | "ready" | "degraded";
  /** Chunks dans l'index fantôme (dernier état connu). */
  size: number;
  /** Comparaisons faites. */
  queries: number;
  /** Moyenne de |top-k servi ∩ top-k fantôme| / k. */
  overlapMean: number | null;
  /** Part des requêtes où le premier résultat est le même. */
  top1Rate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Comparaisons ignorées parce qu'une autre était en cours. */
  skipped: number;
  /** Erreurs par code (`dim`, `exit`, `timeout`…). */
  errors: Record<string, number>;
}

const INDEX_ID = "rag-shadow";
/** Latences gardées pour les quantiles (fenêtre glissante). */
const WINDOW = 1000;

const quantile = (xs: readonly number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! * 1000) / 1000;
};

/** Nom de modèle rangé dans `rag_chunks.model`, ramené au format `Code` des contrats. */
const codeOf = (s: string | null | undefined) => (s ?? "").replace(/[^A-Za-z0-9._:+/@-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 128) || "unknown";

export class VectorShadow {
  private signature = "";
  private known = new Set<number>();
  private dim = 0;
  private built = false;
  private busy: Promise<void> | null = null;
  private stopped = false;
  private queries = 0;
  private overlapSum = 0;
  private top1 = 0;
  private skipped = 0;
  private size = 0;
  private readonly times: number[] = [];
  private readonly errors: Record<string, number> = {};

  constructor(
    private readonly db: Db,
    readonly kind: VectorIndexKind,
    private readonly provider: ShadowProvider,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /**
   * Rejoue une recherche servie. Ne rejette jamais et ne se fait pas attendre par la recherche : le
   * résultat servi est déjà rendu. `served` = top-k servi (avant plafond par document), dans l'ordre.
   */
  observe(query: Float32Array, served: readonly { docId: string; ord: number }[], k: number): void {
    if (this.stopped) return;
    if (this.busy) {
      this.skipped++;
      return;
    }
    this.busy = this.compare(query.slice(), served.slice(0, k), k)
      .catch((e: unknown) => this.fail(e))
      .finally(() => {
        this.busy = null;
      });
  }

  /** Attend la comparaison en cours (tests, arrêt). */
  async idle(): Promise<void> {
    await this.busy;
  }

  private fail(e: unknown): void {
    const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "error";
    this.errors[code] = (this.errors[code] ?? 0) + 1;
    if (!this.provider.available) this.stopped = true;
    this.log(`rag shadow ${this.kind} err=${code}${this.stopped ? " stopped=1" : ""}`);
  }

  private spec(model: string | null): IndexSpec {
    return {
      indexId: INDEX_ID,
      metric: "cosine",
      embedding: {
        model: codeOf(model),
        kind: "dense",
        dim: this.dim,
        strategy: "symmetric",
        pooling: "cls",
        normalize: true,
        quantization: "f32",
        tokenizerSha256: null,
      },
    };
  }

  private rows(where: string, ...args: number[]): VectorRow[] {
    return this.db
      .all<{ id: number; dim: number; embedding: Buffer }>(`SELECT id, dim, embedding FROM rag_chunks ${where}`, ...args)
      .filter((r) => r.dim === this.dim)
      .map((r) => ({ id: r.id, vector: blobToFloats(r.embedding).slice() }));
  }

  /** Aligne l'index fantôme sur `rag_chunks` (voir l'en-tête). */
  private async sync(): Promise<void> {
    const sig = this.db.get<{ n: number; m: number | null; d: number | null; model: string | null }>(
      "SELECT count(*) AS n, max(id) AS m, max(dim) AS d, max(model) AS model FROM rag_chunks",
    );
    const signature = `${sig?.n ?? 0}:${sig?.m ?? 0}:${sig?.d ?? 0}`;
    if (this.built && signature === this.signature) return;
    const dim = sig?.d ?? 0;
    if (!this.built || dim !== this.dim) {
      this.dim = dim;
      this.built = false;
      if (dim) {
        const rows = this.rows("ORDER BY id");
        await this.provider.rebuild(this.spec(sig?.model ?? null), rows);
        this.known = new Set(rows.map((r) => r.id));
        this.built = true;
      }
    } else {
      const current = new Set(this.db.all<{ id: number }>("SELECT id FROM rag_chunks").map((r) => r.id));
      const gone = [...this.known].filter((id) => !current.has(id));
      const fresh = [...current].filter((id) => !this.known.has(id));
      if (gone.length) await this.provider.remove(INDEX_ID, gone);
      if (fresh.length) {
        const max = Math.max(...fresh);
        const min = Math.min(...fresh);
        const want = new Set(fresh);
        await this.provider.upsert(INDEX_ID, this.rows("WHERE id BETWEEN ? AND ?", min, max).filter((r) => want.has(r.id)));
      }
      this.known = current;
    }
    this.size = this.known.size;
    this.signature = signature;
  }

  private async compare(query: Float32Array, served: readonly { docId: string; ord: number }[], k: number): Promise<void> {
    if (!this.provider.available) {
      this.stopped = true;
      throw Object.assign(new Error("indisponible"), { code: "unavailable" });
    }
    await this.sync();
    if (!this.built || !served.length) return;
    if (query.length !== this.dim) throw Object.assign(new Error("dimension"), { code: "dim" });
    const t0 = performance.now();
    const hits = await this.provider.search({ indexId: INDEX_ID, vector: query, k });
    const ms = performance.now() - t0;
    const ids = hits.map((h) => h.id);
    const keys = new Map<number, string>();
    if (ids.length) {
      for (const r of this.db.all<{ id: number; doc_id: string; ord: number }>(
        `SELECT id, doc_id, ord FROM rag_chunks WHERE id IN (${ids.map(() => "?").join(",")})`,
        ...ids,
      ))
        keys.set(r.id, `${r.doc_id}#${r.ord}`);
    }
    const shadow = ids.map((id) => keys.get(id) ?? `?${id}`);
    const servedKeys = served.map((s) => `${s.docId}#${s.ord}`);
    const inter = shadow.filter((key) => servedKeys.includes(key)).length;
    const overlap = inter / Math.min(k, servedKeys.length);
    const same = shadow[0] === servedKeys[0];
    this.queries++;
    this.overlapSum += overlap;
    if (same) this.top1++;
    this.times.push(ms);
    if (this.times.length > WINDOW) this.times.shift();
    this.log(`rag shadow ${this.kind} k=${k} overlap=${overlap.toFixed(3)} top1=${same ? 1 : 0} ms=${ms.toFixed(2)} size=${this.size}`);
  }

  report(): ShadowReport {
    const q = this.queries;
    return {
      engine: this.provider.info(),
      state: this.stopped ? "degraded" : this.built ? "ready" : "idle",
      size: this.size,
      queries: q,
      overlapMean: q ? Math.round((this.overlapSum / q) * 10_000) / 10_000 : null,
      top1Rate: q ? Math.round((this.top1 / q) * 10_000) / 10_000 : null,
      p50Ms: quantile(this.times, 0.5),
      p95Ms: quantile(this.times, 0.95),
      skipped: this.skipped,
      errors: { ...this.errors },
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.idle();
    await this.provider.close();
  }
}
