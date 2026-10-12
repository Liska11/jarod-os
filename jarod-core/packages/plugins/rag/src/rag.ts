// Portage de packages/core/src/services/rag.ts (rév. 2e180305).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, isAbsolute } from "node:path";
import { type Db, ftsQuery } from "@jarod/plugin-storage";
import { DocumentManifest, type DocumentParser, ecosystemFlags, type ProviderDef, type RerankerProvider, type RerankShadowEntry, type VoicePriority } from "@jarod/contracts";
import { chunkDocument, chunkTextSpans, type DocumentChunk, sectionAt } from "./chunker.js";
import { BUILTIN_PARSER_NAME, BuiltinParser, TEXT_EXT } from "./parser-builtin.js";
import { WorkerParser } from "./parser-worker.js";
import { withFallback } from "./parser-fallback.js";
import { routeByExtension } from "./parser-route.js";
import type { VectorShadow } from "./shadow.js";
import type { VectorIndex } from "./vector-index.js";

/**
 * Port structurel de `ProviderRouter` (providers/index.ts) : RagService n'en lit que `def()`.
 * plugin-llm dépend déjà de plugin-rag (describeAttachment) ; importer son type ferait un cycle.
 */
export interface ProviderRouter {
  def(id: string): ProviderDef;
}
import type { Settings, SettingsService } from "@jarod/plugin-storage";

/**
 * Local retrieval. Chunks are embedded by a local endpoint, kept in this app's own database — which
 * is already encrypted at rest and already in the backups, so a second index file would only add a
 * second thing to lose — and searched by cosine similarity in JavaScript.
 *
 * Nothing leaves the machine by default: the embeddings endpoint follows the active provider when it
 * is a local one, and otherwise has to be pointed somewhere explicitly.
 */

export interface RagHit {
  docId: string;
  ord: number;
  text: string;
  score: number;
  source: string | null;
}

export interface RagStatus {
  enabled: boolean;
  chunks: number;
  docs: number;
  /** Dimensions of the stored vectors; a different query dimension means the model changed. */
  dim: number | null;
  model: string | null;
  endpoint: string | null;
  capPerDoc: number;
}

/** Embeds a batch of texts. Injectable so tests never need a model server. */
export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

export interface RagDeps {
  db: Db;
  settings: SettingsService;
  providers: ProviderRouter;
  fetch?: typeof fetch;
  /** Jarod-cordis (G2) : index vectoriel en mémoire ; absent = balayage complet d'origine. */
  index?: VectorIndex;
  /**
   * Jarod-cordis (PLAN §10 phase 1) : moteur rejoué en mode fantôme quand le profil pose
   * `ecosystem.vectorShadow` du même type ; sans effet sur les résultats servis (`shadow.ts`).
   */
  shadow?: VectorShadow;
  /**
   * Jarod-cordis (PLAN §10 phase 2, lot A) : parseur qui décrit chaque document indexé (manifeste, repérage des
   * chunks). Absent = `builtin` (la lecture texte d'origine). Il ne change ni le texte ni les chunks.
   */
  parser?: DocumentParser;
  /**
   * Jarod-cordis (SPECS-P5-VOIX-PRIORITAIRE.md) : priorité de la voix, lue PARESSEUSEMENT à chaque embarquement d'ingestion
   * (jamais au démarrage : l'ordre de chargement des plugins ne compte pas). Absente ou inactive : aucune attente.
   */
  voice?: () => VoicePriority | undefined;
  /** Journal des pauses de plus d'une seconde. */
  log?: (line: string) => void;
  /**
   * Jarod-cordis (SPECS-P5-EMBEDDINGS.md §3.5) : URL du worker d'embeddings de l'application (`…/v1`), utilisée quand le profil
   * n'a PAS d'URL explicite, avant le fournisseur actif local. Jamais écrite dans les réglages. Vide ou blanche = absente.
   */
  embeddingsDefaultUrl?: string;
  /**
   * Jarod-cordis (SPECS-P5-RERANKER.md §3) : reranker lu PARESSEUSEMENT à chaque recherche (le plugin qui le fournit peut se charger avant
   * ou après celui-ci). Sans effet tant que `ecosystem.reranker` est éteint ou que son budget (`rerankTopN`, `rerankDeadlineMs`) manque.
   */
  reranker?: () => RerankerProvider | undefined;
  /** Rapport fantôme / actif du reranker : identifiants et nombres seulement (`RerankShadowEntry`). */
  rerankReport?: (entry: RerankShadowEntry) => void;
  /** SPECS-P5-RERANKER-PAUSE.md §2 : file des reclassements fantômes différés pendant une dictée (défauts : 8 en attente, 120 s de péremption). */
  rerankDeferral?: { max?: number; staleMs?: number };
  /** Identifiant du profil pour les entrées du rapport (défaut `default`). */
  profile?: string;
}

/** Server-side batch size: standard OpenAI shape, small enough for any local server. */
const EMBED_BATCH = 16;
const MAX_TEXT = 1 << 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 2000;
/** Directories that hold no prose worth embedding. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", "build", "release", ".next", "coverage"]);

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Cosine similarity. Zero vectors score zero rather than producing NaN. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function floatsToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function blobToFloats(b: Buffer): Float32Array {
  if (b.byteLength % 4 !== 0) throw new Error("RAG_BAD_BLOB: longueur non multiple de 4.");
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  // The driver can hand back a view into a pooled buffer, and a Float32Array needs an aligned start:
  // copy into a fresh, aligned ArrayBuffer rather than reading shifted numbers.
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
}

/**
 * Reads an embeddings response. Both shapes are accepted because the local servers do not agree:
 * OpenAI (llama-server, LM Studio, Ollama's /v1) returns `data[].embedding`, Ollama's native
 * /api/embed returns `embeddings[][]`.
 */
export function readEmbeddings(json: unknown): Float32Array[] {
  const o = json as { data?: { embedding?: number[] }[]; embeddings?: number[][] } | null;
  if (Array.isArray(o?.data)) {
    return o.data
      .map((d) => Float32Array.from(Array.isArray(d?.embedding) ? d.embedding : []))
      .filter((v) => v.length > 0);
  }
  if (Array.isArray(o?.embeddings)) {
    return o.embeddings.filter(Array.isArray).map((v) => Float32Array.from(v));
  }
  return [];
}

/** Formats binaires lus par les workers (DECISIONS 2026-09-30) et leur borne de taille (celle du worker). */
const DOCUMENT_MAX_BYTES: Readonly<Record<string, number>> = { ".pdf": 100 * 1024 * 1024, ".docx": 25 * 1024 * 1024, ".pptx": 25 * 1024 * 1024, ".xlsx": 25 * 1024 * 1024 };

/** Lists the files of a folder worth indexing: text files, bounded in number and size. */
export function listTextFiles(dir: string): string[] {
  return walkFiles(dir, (name, size) => size > 0 && size <= MAX_FILE_BYTES && TEXT_EXT.has(extname(name).toLowerCase()));
}

/** Les PDF et fichiers Office d'un dossier, bornés en nombre et en taille (comme les fichiers texte). */
export function listDocumentFiles(dir: string): string[] {
  return walkFiles(dir, (name, size) => {
    const max = DOCUMENT_MAX_BYTES[extname(name).toLowerCase()];
    return max !== undefined && size > 0 && size <= max;
  });
}

/**
 * M4 — l'identifiant d'un document est son chemin ABSOLU normalisé (barres obliques), jamais un chemin
 * relatif au dossier indexé : `projetA/README.md` et `projetB/README.md` portaient le MÊME `docId`, donc
 * indexer le second SUPPRIMAIT le premier (`DELETE FROM rag_chunks WHERE doc_id = ?` avant réécriture).
 * Le nom affiché reste le chemin relatif (`source`).
 */
export const docIdOf = (path: string): string => resolve(path).split("\\").join("/");

function walkFiles(dir: string, accept: (name: string, size: number) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    if (found.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found.length >= MAX_FILES) return;
      const path = join(current, name);
      try {
        const st = statSync(path);
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(name)) walk(path);
          continue;
        }
        if (!st.isFile() || !accept(name, st.size)) continue;
        found.push(path);
      } catch {
        // An unreadable entry is skipped rather than failing the whole index.
      }
    }
  };
  walk(dir);
  return found;
}

/** `INSERT OR REPLACE` d'une ligne de `rag_documents` : le manifeste tel que rendu, le texte auquel il renvoie. */
const DOCUMENT_ROW = (
  docId: string,
  doc: { manifest: DocumentManifest; text: string },
  contentSha: string,
  source: string | null,
  at: number,
): [string, ...(string | number | null)[]] => [
  "INSERT OR REPLACE INTO rag_documents (doc_id, source, parser, parser_version, source_sha256, content_sha256, manifest, text, state, at) VALUES (?,?,?,?,?,?,?,?,'indexed',?)",
  docId,
  source,
  doc.manifest.parser.name,
  doc.manifest.parser.version,
  doc.manifest.source.sha256,
  contentSha,
  JSON.stringify(doc.manifest),
  doc.text,
  at,
];

/**
 * `totalMs` d'une entrée du rapport de reclassement : durée de la recherche telle que l'appelant la vit. Fantôme : jusqu'à son retour
 * (`servedAt`, le calcul n'est pas attendu) ; actif : jusqu'à l'horodatage UNIQUE lu dans `report` (la recherche rend juste après).
 * Absent d'un rejeu différé. Le calcul vit dans `report` : c'est le même `now` que `ms`, sinon les deux lectures
 * se décalaient d'une milliseconde et l'invariant `totalMs ≥ ms` perdait.
 */
export class RagService {
  private embedder: Embedder | null = null;
  private readonly parser: DocumentParser;

  private readonly workers: WorkerParser[] = [];

  constructor(private readonly d: RagDeps) {
    if (d.parser) {
      this.parser = d.parser;
      return;
    }
    // Drapeau lu à la construction : le changer demande un redémarrage. Chemins jamais devinés ni cherchés dans le PATH ;
    // vides ou relatifs ⇒ commande vide ⇒ WORKER_MISSING, donc repli `builtin` AVEC le code dans le manifeste (ou refus net
    // pour un PDF, que `builtin` ne sait pas lire). DECISIONS 2026-09-30 (option b) : Office et HTML par Docling, PDF par pdfium.
    if (ecosystemFlags(d.settings.get("ecosystem")).documentParser === "docling") {
      const { doclingPython, doclingWorker, pdfiumWorker } = d.settings.get("rag");
      const py = isAbsolute(doclingPython) ? doclingPython : "";
      const allowPath = (path: string): boolean => {
        const workspace = d.settings.getAll().workspace;
        if (!workspace) return false;
        const root = resolve(workspace);
        const rel = relative(root, resolve(root, path));
        return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
      };
      const office = new WorkerParser({
        name: "docling",
        command: isAbsolute(doclingWorker) ? py : "",
        args: [doclingWorker],
        extensions: [".docx", ".pptx", ".xlsx", ".html"],
        allowPath,
        timeoutMs: 120_000,
        startTimeoutMs: 60_000,
        maxBytes: 25 * 1024 * 1024,
        threads: 2,
      });
      const pdf = new WorkerParser({
        name: "pdfium",
        command: isAbsolute(pdfiumWorker) ? py : "",
        args: [pdfiumWorker],
        extensions: [".pdf"],
        allowPath,
        timeoutMs: 120_000,
        startTimeoutMs: 30_000,
        maxBytes: 100 * 1024 * 1024,
        threads: 1,
      });
      this.workers.push(office, pdf);
      this.parser = withFallback(routeByExtension(office, pdf), new BuiltinParser());
    } else this.parser = new BuiltinParser();
  }

  /** Arrête les workers de parsing s'ils tournent (fermeture du plugin). */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }

  /** Test hook: takes an embedder instead of an HTTP endpoint. */
  setEmbedder(fn: Embedder | null): void {
    this.embedder = fn;
  }

  /**
   * The retrieval settings, bounded. They are stored as free-form JSON, so a hand-edited value — a
   * chunk size of 0, a cap of ten thousand — must not be able to explode the index or the query.
   */
  private cfg(): Settings["rag"] {
    const r = this.d.settings.get("rag");
    const int = (v: number, fallback: number, min: number, max: number) =>
      Math.min(max, Math.max(min, Math.floor(Number(v)) || fallback));
    const chunkSize = int(r.chunkSize, 800, 100, 4000);
    return {
      ...r,
      chunkSize,
      // At most half a chunk: an overlap equal to the size would make each chunk advance one single
      // character, turning a 256 KB file into a hundred thousand chunks.
      chunkOverlap: Math.min(int(r.chunkOverlap, 0, 0, 1000), Math.floor(chunkSize / 2)),
      maxChunksPerDoc: int(r.maxChunksPerDoc, 1, 1, 20),
      topK: int(r.topK, 5, 1, 50),
    };
  }

  /**
   * Where embeddings would come from, or null when nowhere does. Non-throwing on purpose: reading a
   * status panel, or ingesting with an embedder already in hand, must not fail on a missing URL.
   */
  private resolve(): { url: string; model: string | null } | null {
    const rag = this.cfg();
    const model = rag.embeddingsModel.trim() || null;
    if (rag.embeddingsUrl.trim()) return { url: rag.embeddingsUrl.trim().replace(/\/+$/, ""), model };
    const appUrl = this.d.embeddingsDefaultUrl?.trim();
    if (appUrl) return { url: appUrl.replace(/\/+$/, ""), model };
    const def = this.d.providers.def(this.d.settings.getAll().activeProvider);
    if (!def.local) return null;
    return { url: def.baseUrl.replace(/\/+$/, ""), model };
  }

  /**
   * The endpoint embeddings are read from. An explicit setting wins; otherwise the active provider
   * is used only when it is a local one — a feature that exists to keep documents on the machine
   * must not quietly ship them to a cloud provider. Throws, because this caller needs a URL.
   */
  endpoint(): { url: string; model: string | null } {
    const found = this.resolve();
    if (found) return found;
    const def = this.d.providers.def(this.d.settings.getAll().activeProvider);
    throw new Error(
      `RAG local : le fournisseur actif « ${def.name} » n'est pas local. Choisissez un fournisseur local ` +
        "ou indiquez une URL d'embeddings (Réglages › Documents : « Embeddings server »).",
    );
  }

  status(): RagStatus {
    const rag = this.cfg();
    const row = this.d.db.get<{ chunks: number; docs: number; dim: number | null }>(
      "SELECT count(*) AS chunks, count(DISTINCT doc_id) AS docs, max(dim) AS dim FROM rag_chunks",
    );
    // Reported as null rather than thrown: the status screen must open even when nothing is set up.
    const found = this.resolve();
    return {
      enabled: rag.enabled,
      chunks: row?.chunks ?? 0,
      docs: row?.docs ?? 0,
      dim: row?.dim ?? null,
      model: rag.embeddingsModel.trim() || null,
      endpoint: found ? `${found.url}/embeddings` : null,
      capPerDoc: rag.maxChunksPerDoc,
    };
  }

  /**
   * `background` = embarquement d'INGESTION (`replaceDocument`) : avant chaque lot de `EMBED_BATCH` passages, on attend que la
   * voix ne soit plus active (SPECS-P5-VOIX-PRIORITAIRE.md). Jamais pour une requête de recherche. Sans priorité de voix, le
   * comportement est exactement celui d'avant.
   */
  private async embed(texts: string[], background = false): Promise<Float32Array[]> {
    const voice = background ? this.voiceSafe() : undefined;
    if (this.embedder && !voice) return this.embedder(texts);
    const endpoint = this.embedder ? null : this.endpoint();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      if (voice) await this.yieldToVoice(voice);
      const vectors = this.embedder ? await this.embedder(batch) : await this.fetchBatch(endpoint!, batch);
      if (!this.embedder && vectors.length !== batch.length) {
        throw new Error(`RAG_EMBED_BAD_RESPONSE: ${vectors.length} vecteurs pour ${batch.length} textes.`);
      }
      out.push(...vectors);
    }
    return out;
  }

  private async fetchBatch({ url, model }: { url: string; model: string | null }, batch: string[]): Promise<Float32Array[]> {
    const doFetch = this.d.fetch ?? fetch;
    const res = await doFetch(`${url}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: batch, ...(model ? { model } : {}) }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `RAG_EMBED_HTTP_${res.status} sur ${url}/embeddings${detail ? ` — ${detail}` : ""}. ` +
          "Un serveur d'embeddings répond-il à cette adresse ?",
      );
    }
    return readEmbeddings(await res.json());
  }

  private voiceStats = { pauses: 0, pausedMs: 0 };

  /** Compteurs en mémoire des pauses cédées à la voix (pour les tests et le banc de contention). */
  voicePauses(): { pauses: number; pausedMs: number } {
    return { ...this.voiceStats };
  }

  /** La priorité de la voix si le fournisseur la donne ; une défaillance du fournisseur ne bloque JAMAIS l'ingestion. */
  private voiceSafe(): VoicePriority | undefined {
    try {
      return this.d.voice?.();
    } catch (e) {
      this.d.log?.(`voix prioritaire indisponible, ingestion sans pause : ${(e as Error).message}`);
      return undefined;
    }
  }

  private async yieldToVoice(voice: VoicePriority): Promise<void> {
    try {
      if (!voice.active) return;
      const t0 = Date.now();
      await voice.whenIdle();
      const dt = Date.now() - t0;
      this.voiceStats.pauses += 1;
      this.voiceStats.pausedMs += dt;
      if (dt > 1000) this.d.log?.(`ingestion cédée à la voix pendant ${(dt / 1000).toFixed(1)} s`);
    } catch (e) {
      // Fail-open : la priorité de la voix ne doit jamais bloquer le RAG.
      this.d.log?.(`voix prioritaire en erreur, ingestion poursuivie : ${(e as Error).message}`);
    }
  }

  /** L'interrupteur « Index and search documents », relu à chaque appel (les outils RAG n'existent pour le modèle que tant qu'il est allumé). */
  isEnabled(): boolean {
    return this.cfg().enabled === true;
  }

  private assertEnabled(): void {
    if (!this.cfg().enabled) {
      throw new Error("RAG local désactivé (Réglages › Documents : « Index and search documents »).");
    }
  }

  /**
   * Adds a document to the index. Re-indexing the same content is a no-op; re-indexing a document
   * whose content changed replaces its chunks, so an updated file cannot leave a stale version of
   * itself behind.
   */
  async ingest(
    text: string,
    meta: { docId?: string; source?: string; bytes?: Uint8Array; parsed?: { manifest: DocumentManifest; text: string } } = {},
  ): Promise<{ docId: string; chunks: number; deduped: boolean }> {
    this.assertEnabled();
    const content = String(text ?? "");
    if (!content.trim()) throw new Error("RAG_EMPTY_TEXT: rien à indexer.");
    if (content.length > MAX_TEXT) throw new Error(`RAG_TOO_LARGE: ${content.length} caractères, maximum ${MAX_TEXT}.`);

    const current = this.cfg();
    const docId = meta.docId?.trim() || sha256(content).slice(0, 16);
    const hash = sha256(content);
    const known = this.d.db.get<{ id: number }>(
      "SELECT id FROM rag_chunks WHERE doc_id = ? AND sha256 = ? LIMIT 1",
      docId,
      hash,
    );
    if (known) {
      // Contenu déjà indexé : rien n'est recalculé, mais un document indexé avant la v19 reçoit son manifeste.
      if (!this.d.db.get("SELECT 1 AS x FROM rag_documents WHERE doc_id = ? AND content_sha256 = ?", docId, hash)) {
        const doc = await this.describe(content, meta);
        if (doc) this.d.db.run(...DOCUMENT_ROW(docId, doc, hash, meta.source ?? null, Date.now()));
      }
      return { docId, chunks: 0, deduped: true };
    }

    const doc = await this.describe(content, meta);
    const pieces: DocumentChunk[] = chunkTextSpans(content, current.chunkSize, current.chunkOverlap).map((c) => ({
      ...c,
      page: null,
      section: doc ? sectionAt(doc.manifest.sections, c.start) : null,
    }));
    await this.replaceDocument({ docId, source: meta.source ?? null, hash, doc, pieces });
    return { docId, chunks: pieces.length, deduped: false };
  }

  /**
   * Embeds `pieces` and swaps them in for the chunks of `docId`, in ONE transaction: a document is never seen
   * half replaced. Shared by `ingest` and `reindex` — one code path writes chunks, spans and the document row.
   */
  private async replaceDocument(w: {
    docId: string;
    source: string | null;
    hash: string;
    doc: { manifest: DocumentManifest; text: string } | null;
    pieces: DocumentChunk[];
  }): Promise<void> {
    const current = this.cfg();
    const vectors = await this.embed(w.pieces.map((p) => p.text), true);
    const model = current.embeddingsModel.trim() || this.resolve()?.model || null;
    const at = Date.now();
    this.d.index?.invalidate();
    this.d.db.tx(() => {
      // A new version of a known document replaces the old one instead of piling up next to it
      // (le repérage des anciens chunks part avec eux : `rag_chunk_spans` est en cascade).
      this.d.db.run("DELETE FROM rag_chunks WHERE doc_id = ?", w.docId);
      w.pieces.forEach((piece, ord) => {
        const vector = vectors[ord]!;
        this.d.db.run(
          "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?,?,?,?,?,?,?,?,?)",
          w.docId,
          ord,
          piece.text,
          vector.length,
          floatsToBlob(vector),
          w.hash,
          w.source,
          model,
          at,
        );
        if (w.doc) {
          this.d.db.run(
            "INSERT INTO rag_chunk_spans (chunk_id, char_start, char_end, page, section) SELECT id, ?, ?, ?, ? FROM rag_chunks WHERE doc_id = ? AND ord = ?",
            piece.start,
            piece.end,
            piece.page,
            piece.section,
            w.docId,
            ord,
          );
        }
      });
      if (w.doc) this.d.db.run(...DOCUMENT_ROW(w.docId, w.doc, w.hash, w.source, at));
      else this.d.db.run("DELETE FROM rag_documents WHERE doc_id = ?", w.docId);
    });
  }

  /** Ce qu'un « Reindex » ferait, SANS rien embarquer ni changer : documents refaisables, leurs passages actuels, documents non refaisables (§ 20). */
  reindexPlan(): { documents: number; chunks: number; missing: number } {
    this.assertEnabled();
    const docs = this.d.db.get<{ n: number }>("SELECT count(*) AS n FROM rag_documents")?.n ?? 0;
    const chunks = this.d.db.get<{ n: number }>("SELECT count(*) AS n FROM rag_chunks WHERE doc_id IN (SELECT doc_id FROM rag_documents)")?.n ?? 0;
    const missing = this.d.db.get<{ n: number }>("SELECT count(DISTINCT doc_id) AS n FROM rag_chunks WHERE doc_id NOT IN (SELECT doc_id FROM rag_documents)")?.n ?? 0;
    return { documents: docs, chunks, missing };
  }

  /**
   * Rebuilds the chunks and embeddings of the indexed documents FROM THEIR MANIFEST AND STORED TEXT — the original
   * files are not read (they may be gone or changed). For a new chunk size, a new embedding model, a new
   * chunking rule. A `builtin` document is cut as at ingestion; a structured one by `chunkDocument`. Each document
   * is replaced atomically; an embedding failure stops the run and leaves the documents not yet reached untouched
   * (dimensions can then be mixed until it is run again — search says so, `RAG_DIM_MISMATCH`). Documents indexed
   * before the manifests existed have none: they are counted in `missing` and untouched — `rag_index` on their
   * file (unchanged content is not re-embedded) gives them one.
   *
   * `onProgress` : appelé une fois à 0 puis après chaque document ; `signal` : lu AVANT chaque document (le document en cours va
   * jusqu'au bout, il est atomique), la passe rend alors `cancelled: true`. Chaque document est RELU à son tour : un texte modifié
   * entre-temps est découpé tel qu'il est maintenant, un document disparu est sauté (§ 20).
   */
  async reindex(
    opts: { docId?: string; onProgress?: (p: { done: number; total: number; docId: string | null }) => void; signal?: AbortSignal } = {},
  ): Promise<{ documents: number; chunks: number; missing: number; cancelled?: true }> {
    this.assertEnabled();
    const one = opts.docId?.trim();
    const ids = this.d.db
      .all<{ doc_id: string }>(`SELECT doc_id FROM rag_documents${one ? " WHERE doc_id = ?" : ""} ORDER BY doc_id`, ...(one ? [one] : []))
      .map((r) => r.doc_id);
    const missing =
      this.d.db.get<{ n: number }>(
        `SELECT count(DISTINCT doc_id) AS n FROM rag_chunks WHERE doc_id NOT IN (SELECT doc_id FROM rag_documents)${one ? " AND doc_id = ?" : ""}`,
        ...(one ? [one] : []),
      )?.n ?? 0;
    if (one && !ids.length) {
      throw new Error(
        missing
          ? `RAG_NO_MANIFEST: « ${one} » a été indexé avant les manifestes ; relancez rag_index sur son fichier.`
          : `RAG_UNKNOWN_DOC: « ${one} » n'est pas indexé.`,
      );
    }
    const cfg = this.cfg();
    const total = ids.length;
    let documents = 0;
    let chunks = 0;
    let done = 0;
    let cancelled = false;
    opts.onProgress?.({ done, total, docId: null });
    for (const id of ids) {
      if (opts.signal?.aborted) {
        cancelled = true;
        break;
      }
      const row = this.d.db.get<{ doc_id: string; source: string | null; content_sha256: string; manifest: string; text: string }>(
        "SELECT doc_id, source, content_sha256, manifest, text FROM rag_documents WHERE doc_id = ?",
        id,
      );
      if (row) {
        let manifest: DocumentManifest;
        try {
          manifest = DocumentManifest.parse(JSON.parse(row.manifest));
        } catch {
          throw new Error(`RAG_BAD_MANIFEST: manifeste illisible pour « ${row.doc_id} » ; relancez rag_index sur son fichier après \`forget\`.`);
        }
        const doc = { manifest, text: row.text };
        const pieces: DocumentChunk[] =
          manifest.parser.name === BUILTIN_PARSER_NAME
            ? chunkTextSpans(row.text, cfg.chunkSize, cfg.chunkOverlap).map((c) => ({ ...c, page: null, section: sectionAt(manifest.sections, c.start) }))
            : chunkDocument(doc, cfg.chunkSize, cfg.chunkOverlap);
        documents++;
        if (pieces.length) {
          await this.replaceDocument({ docId: row.doc_id, source: row.source, hash: row.content_sha256, doc, pieces });
          chunks += pieces.length;
        }
      }
      done++;
      opts.onProgress?.({ done, total, docId: id });
    }
    return { documents, chunks, missing, ...(cancelled ? { cancelled: true as const } : {}) };
  }

  /**
   * Manifeste et texte du document, par le parseur. Sert de description : un échec ne fait jamais échouer
   * l'indexation (le document est alors indexé comme avant, sans manifeste). Le texte rendu doit être celui qu'on
   * découpe : sinon (caractère isolé d'une paire de substitution, par exemple) on garde le texte reçu et on
   * renonce aux sections, avec un code d'erreur dans le manifeste — jamais des décalages qui ne correspondent pas.
   */
  private async describe(
    content: string,
    meta: { docId?: string; source?: string; bytes?: Uint8Array; parsed?: { manifest: DocumentManifest; text: string } },
  ): Promise<{ manifest: DocumentManifest; text: string } | null> {
    if (meta.parsed && meta.parsed.text === content) return meta.parsed; // déjà lu par l'appelant : pas de seconde lecture du fichier
    const name = meta.source ?? meta.docId ?? "document";
    try {
      let parsed = await this.parser.parse({ bytes: meta.bytes ?? Buffer.from(content, "utf8"), name });
      if (parsed.text !== content && meta.bytes) parsed = await this.parser.parse({ bytes: Buffer.from(content, "utf8"), name });
      if (parsed.text === content) return parsed;
      return {
        manifest: { ...parsed.manifest, sections: [], errors: [...parsed.manifest.errors, { code: "TEXT_NOT_ROUNDTRIP", page: null }] },
        text: content,
      };
    } catch {
      return null;
    }
  }

  /** Indexes every text file of a folder. Returns what it did, so the caller can report it. */
  /** Extensions des PDF/Office que les workers savent lire (vide si `ecosystem.documentParser` est éteint). */
  documentExtensions(): ReadonlySet<string> {
    return this.workers.length ? new Set(Object.keys(DOCUMENT_MAX_BYTES)) : new Set();
  }

  /**
   * Lit un PDF ou un fichier Office par son worker et l'indexe (le texte extrait, les octets d'origine). Un échec du
   * worker ou du document lève une erreur dont le message commence par un CODE (jamais un texte du document).
   */
  async indexDocument(path: string, rel: string): Promise<{ docId: string; chunks: number; deduped: boolean }> {
    this.assertEnabled();
    if (!this.documentExtensions().has(extname(path).toLowerCase())) throw new Error("RAG_FORMAT_UNSUPPORTED: format non lu (drapeau documentParser éteint ou extension inconnue).");
    const bytes = readFileSync(path);
    let parsed: { manifest: DocumentManifest; text: string };
    try {
      parsed = await this.parser.parse({ bytes, name: rel });
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "PARSER_ERROR";
      throw new Error(`${code}: ${rel} illisible.`);
    }
    this.dropLegacyDocId(rel);
    return this.ingest(parsed.text, { docId: docIdOf(path), source: rel, bytes, parsed });
  }

  /**
   * M4 — retire le document enregistré sous un identifiant HÉRITÉ : le chemin RELATIF, ce qu'était un
   * `docId` avant ce correctif. Sans ça, réindexer laisserait DEUX documents pour un seul fichier (l'ancien
   * relatif, le nouveau absolu). Un identifiant déjà absolu n'est pas hérité : on n'y touche pas (sinon on
   * supprimerait le document qu'on s'apprête à écrire, et sa déduplication avec lui).
   */
  private dropLegacyDocId(legacy: string): void {
    if (!legacy || legacy === docIdOf(legacy)) return;
    this.d.db.tx(() => {
      // `rag_chunk_spans` est en cascade sur les chunks : rien d'autre à nettoyer.
      this.d.db.run("DELETE FROM rag_chunks WHERE doc_id = ?", legacy);
      this.d.db.run("DELETE FROM rag_documents WHERE doc_id = ?", legacy);
    });
  }

  async indexFolder(
    dir: string,
  ): Promise<{ files: number; chunks: number; deduped: number; documents?: number; refused?: { file: string; code: string }[] }> {
    this.assertEnabled();
    const files = listTextFiles(dir);
    let chunks = 0;
    let deduped = 0;
    for (const path of files) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      const text = bytes.toString("utf8");
      if (text.includes("\u0000")) continue; // Binary that happens to carry a text extension.
      const rel = relative(dir, path).split("\\").join("/");
      this.dropLegacyDocId(rel);
      const result = await this.ingest(text, { docId: docIdOf(path), source: rel, bytes });
      if (result.deduped) deduped += 1;
      else chunks += result.chunks;
    }
    if (!this.workers.length) return { files: files.length, chunks, deduped };
    // PDF et Office : un fichier refusé (taille du texte, document illisible, worker absent) est RAPPORTÉ, l'indexation continue.
    let documents = 0;
    const refused: { file: string; code: string }[] = [];
    for (const path of listDocumentFiles(dir)) {
      const rel = relative(dir, path).split("\\").join("/");
      try {
        const result = await this.indexDocument(path, rel);
        documents += 1;
        if (result.deduped) deduped += 1;
        else chunks += result.chunks;
      } catch (e) {
        const msg = (e as Error).message;
        refused.push({ file: rel, code: msg.slice(0, msg.includes(": ") ? msg.indexOf(": ") : 60).slice(0, 80) });
      }
    }
    return { files: files.length, chunks, deduped, documents, refused };
  }

  /**
   * Nearest chunks, at most `maxChunksPerDoc` per document: without that cap one long file takes
   * every slot and the answer is built from a single source.
   */
  async search(query: string, k?: number): Promise<RagHit[]> {
    const searchStart = Date.now();
    this.assertEnabled();
    const q = String(query ?? "").trim();
    if (!q) return [];
    const rag = this.cfg();
    let scored: RagHit[];
    let qv: Float32Array | undefined;
    if (this.d.index) {
      // Jarod-cordis (G2) : mêmes lignes, même cosinus, même ordre — sans relire la table à chaque fois.
      if (!this.d.index.stats().size) return [];
      [qv] = await this.embed([q]);
      if (!qv) return [];
      scored = this.d.index.ranked(qv);
    } else {
    const rows = this.d.db.all<{
      doc_id: string;
      ord: number;
      text: string;
      dim: number;
      embedding: Buffer;
      source: string | null;
    }>("SELECT doc_id, ord, text, dim, embedding, source FROM rag_chunks");
    if (!rows.length) return [];
    [qv] = await this.embed([q]);
    if (!qv) return [];
    const vector = qv;

    const stored = rows[0]!.dim;
    // M8 : seule la PREMIÈRE ligne était comparée. Une ligne d'une autre dimension passait ensuite dans
    // `cosine()` sans un mot — un score qui ne veut rien dire, présenté comme un résultat.
    const mixed = rows.find((r) => r.dim !== stored);
    if (mixed) {
      throw new Error(
        `RAG_DIM_MISMATCH: index en dimensions mélangées (${stored} et ${mixed.dim}, document « ${mixed.doc_id} »). ` +
          "Réindexez avant de chercher.",
      );
    }
    if (qv.length !== stored) {
      // Comparing vectors of different dimensions is not "approximate", it is meaningless: this
      // happens when the embedding model changed after the index was built.
      throw new Error(
        `RAG_DIM_MISMATCH: index en ${stored} dimensions, requête en ${qv.length}. ` +
          "Le modèle d'embeddings a changé : réindexez avant de chercher.",
      );
    }

    scored = rows
      .map((r) => ({
        docId: r.doc_id,
        ord: r.ord,
        text: r.text,
        source: r.source,
        score: cosine(vector, blobToFloats(r.embedding)),
      }))
      .sort((a, b) => b.score - a.score);
    }

    const perDoc = new Map<string, number>();
    const out: RagHit[] = [];
    const limit = Math.max(1, Number(k) || rag.topK);
    const flags = ecosystemFlags(this.d.settings.get("ecosystem"));
    // Recherche hybride (SPECS-P5-HYBRID.md §2.2) : seul l'ORDRE change ; éteint = la pile d'avant, octet pour octet.
    if (flags.hybrid === "on" && qv) scored = this.fuseLexical(q, qv, scored);
    const shadow = this.d.shadow;
    if (shadow && flags.vectorShadow === shadow.kind) {
      // Rejoué APRÈS le calcul servi, sans attente : ni les résultats ni la latence rendus n'en dépendent.
      shadow.observe(qv, scored.slice(0, limit), limit);
    }
    // Reclassement (SPECS-P5-RERANKER.md §3) : seulement avec drapeau, budget COMPLET et reranker prêt ; sinon `want === limit` et le
    // chemin est celui d'avant, octet pour octet.
    const rr = flags.reranker !== "off" && flags.rerankTopN && flags.rerankDeadlineMs ? this.d.reranker?.() : undefined;
    const usable = rr?.available === true ? rr : undefined;
    const topN = usable ? Math.min(flags.rerankTopN!, usable.maxCandidates) : 0;
    const want = Math.max(limit, topN);
    for (const hit of scored) {
      const seen = perDoc.get(hit.docId) ?? 0;
      if (seen >= rag.maxChunksPerDoc) continue;
      perDoc.set(hit.docId, seen + 1);
      out.push(hit);
      if (out.length >= want) break;
    }
    if (!usable || topN === 0) return out.slice(0, limit);
    const candidates = out.slice(0, topN);
    if (flags.rerankMode === "active") {
      const reranked = await this.rerank(usable, q, candidates, flags.rerankDeadlineMs!, "active", undefined, { start: searchStart });
      if (!reranked || reranked === "paused") return out.slice(0, limit);
      return [...reranked, ...out.filter((h) => !reranked.includes(h))].slice(0, limit);
    }
    // Fantôme : calculé et journalisé APRÈS coup, sans attente ; jamais servi.
    // `servedAt` : la recherche est rendue juste après ; c'est cette durée que `totalMs` rapporte (le calcul fantôme, lui, est dans `ms`).
    const pending = this.rerank(usable, q, candidates, flags.rerankDeadlineMs!, "shadow", undefined, { start: searchStart, servedAt: Date.now() }).then(() => {}, () => {});
    this.trackRerank(pending);
    return out.slice(0, limit);
  }

  /**
   * Fusion RRF (k = 60) des 50 premiers du classement dense et des 50 premiers du classement lexical FTS5 (bm25), clé (doc_id, ord). Le score
   * d'un résultat reste son COSINUS avec la requête (calculé sur le vecteur stocké pour un candidat seulement lexical) ; le reste de la liste
   * dense suit dans son ordre. Égalité de score : meilleur rang lexical d'abord. Requête sans terme, aucune ligne lexicale ou erreur FTS5 : l'ordre dense est rendu tel quel (une ligne de
   * journal avec le CODE de l'erreur, jamais son texte ni la requête).
   */
  private fuseLexical(q: string, qv: Float32Array, dense: RagHit[]): RagHit[] {
    const DEPTH = 50;
    const RRF_K = 60;
    try {
      const fq = ftsQuery(q, "or");
      if (!fq) return dense;
      const rows = this.d.db.all<{ doc_id: string; ord: number; text: string; dim: number; embedding: Buffer; source: string | null }>(
        "SELECT c.doc_id, c.ord, c.text, c.dim, c.embedding, c.source FROM rag_chunks_fts f JOIN rag_chunks c ON c.id = f.rowid WHERE rag_chunks_fts MATCH ? ORDER BY bm25(rag_chunks_fts), c.id LIMIT ?",
        fq,
        DEPTH,
      );
      if (!rows.length) return dense;
      const key = (docId: string, ord: number) => `${docId}\u0000${ord}`;
      const hits = new Map<string, RagHit>();
      const rrf = new Map<string, number>();
      dense.slice(0, DEPTH).forEach((h, r) => {
        const k = key(h.docId, h.ord);
        hits.set(k, h);
        rrf.set(k, 1 / (RRF_K + r + 1));
      });
      const lexRank = new Map<string, number>();
      rows.forEach((r, i) => {
        const k = key(r.doc_id, r.ord);
        if (!hits.has(k)) hits.set(k, { docId: r.doc_id, ord: r.ord, text: r.text, source: r.source, score: r.dim === qv.length ? cosine(qv, blobToFloats(r.embedding)) : 0 });
        rrf.set(k, (rrf.get(k) ?? 0) + 1 / (RRF_K + i + 1));
        lexRank.set(k, i);
      });
      // Égalité de score : le meilleur rang LEXICAL d'abord (règle V1, SPECS-P5-HYBRID.md §3.1), un candidat absent du lexical derrière ; puis
      // l'ordre d'arrivée (dense avant lexical seul), le tri étant stable.
      const fused = [...rrf.entries()]
        .sort((a, b) => b[1] - a[1] || (lexRank.get(a[0]) ?? Infinity) - (lexRank.get(b[0]) ?? Infinity))
        .map(([k]) => hits.get(k)!);
      return [...fused, ...dense.filter((h) => !rrf.has(key(h.docId, h.ord)))];
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "FTS_ERROR";
      this.d.log?.(`recherche hybride indisponible (${code}) : ordre dense conservé`);
      return dense;
    }
  }

  private readonly pendingRerank = new Set<Promise<void>>();

  private trackRerank(p: Promise<void>): void {
    this.pendingRerank.add(p);
    void p.finally(() => this.pendingRerank.delete(p));
  }

  /** Attend les reclassements fantômes en cours, rejeux différés compris (tests, rapport). */
  async rerankIdle(): Promise<void> {
    while (this.pendingRerank.size) await Promise.all([...this.pendingRerank]);
  }

  /** Reclassements fantômes différés pendant une dictée (SPECS-P5-RERANKER-PAUSE.md §2) : mis en file, rejoués, abandonnés. */
  rerankDeferrals(): { deferred: number; replayed: number; stale: number } {
    return { ...this.deferStats };
  }

  private readonly deferStats = { deferred: 0, replayed: 0, stale: 0 };
  /** En MÉMOIRE seulement (textes compris) : jamais écrite, abandonnée au-delà de la borne ou de la péremption. */
  private readonly deferred: { rr: RerankerProvider; query: string; candidates: RagHit[]; chunkIds: number[]; deadlineMs: number; at: number }[] = [];
  private draining: Promise<void> | null = null;

  private report(rr: RerankerProvider, mode: "shadow" | "active", t0: number, chunkIds: number[], outcome: RerankShadowEntry["outcome"], reranked: number[], reason?: string, served?: { start: number; servedAt?: number }): void {
    // UN SEUL horodatage pour `ms` et `totalMs` : deux lectures successives de Date.now() laissaient
    // `ms` être lu APRÈS `totalMs`, et l'invariant totalMs ≥ ms perdait d'une milliseconde (test échouant).
    const now = Date.now();
    const totalMs = served ? Math.max(0, (served.servedAt ?? now) - served.start) : undefined;
    try {
      this.d.rerankReport?.({
        t: now,
        profile: this.d.profile ?? "default",
        engine: rr.info(),
        ms: now - t0,
        outcome,
        mode,
        ...(reason ? { reason } : {}),
        candidates: chunkIds,
        reranked,
        ...(totalMs !== undefined ? { totalMs } : {}),
      });
    } catch {
      /* le rapport ne doit jamais casser une recherche */
    }
  }

  /** Met un reclassement fantôme en file (file bornée : le plus ancien est abandonné) et s'assure qu'un rejeu attend la fin de la dictée. */
  private defer(item: RagService["deferred"][number]): void {
    const max = this.d.rerankDeferral?.max ?? 8;
    this.deferred.push(item);
    while (this.deferred.length > max) {
      const dropped = this.deferred.shift()!;
      this.deferStats.stale += 1;
      this.report(dropped.rr, "shadow", Date.now(), dropped.chunkIds, "stale", [], "queue-full");
    }
    if (!this.draining) {
      this.draining = this.drainDeferred().finally(() => {
        this.draining = null;
      });
      this.trackRerank(this.draining);
    }
  }

  /** Rejoue la file à la fin de la dictée, dans l'ordre d'arrivée. Ne lève jamais. */
  private async drainDeferred(): Promise<void> {
    const staleMs = this.d.rerankDeferral?.staleMs ?? 120_000;
    while (this.deferred.length) {
      const voice = this.voiceSafe();
      if (!voice) {
        // Rien ne dira quand reprendre : jamais de rejeu à l'aveugle.
        for (const it of this.deferred.splice(0)) {
          this.deferStats.stale += 1;
          this.report(it.rr, "shadow", Date.now(), it.chunkIds, "stale", [], "no-voice");
        }
        return;
      }
      try {
        await voice.whenIdle();
      } catch (e) {
        this.d.log?.(`voix prioritaire en erreur, rejeu des reclassements poursuivi : ${(e as Error).message}`);
      }
      const item = this.deferred.shift();
      if (!item) return;
      if (Date.now() - item.at > staleMs) {
        this.deferStats.stale += 1;
        this.report(item.rr, "shadow", Date.now(), item.chunkIds, "stale", [], "too-old");
        continue;
      }
      const res = await this.rerank(item.rr, item.query, item.candidates, item.deadlineMs, "shadow", item.chunkIds);
      if (res === "paused") {
        // La voix s'est rouverte juste avant le rejeu : retour en tête de file et nouvelle attente. Si la voix est pourtant libre (le service
        // refuse seul), abandon : jamais de boucle serrée.
        if (voice.active) this.deferred.unshift(item);
        else {
          this.deferStats.stale += 1;
          this.report(item.rr, "shadow", Date.now(), item.chunkIds, "stale", [], "still-paused");
        }
      } else this.deferStats.replayed += 1;
    }
  }

  /**
   * Un reclassement : les `candidates` (déjà dédoublonnés par document) → même liste, dans l'ordre du reranker, les candidats oubliés
   * à la suite dans leur ordre d'origine ; `null` si le reranker a échoué (échéance, occupé, panne) — l'appelant garde l'ordre d'origine.
   * Écrit toujours une entrée de rapport (identifiants et nombres, aucun texte). Ne lève jamais.
   * Pendant une dictée le service refuse (RERANKER_PAUSED) : en mode actif l'ordre d'origine est servi (issue « paused ») ; en mode fantôme
   * le reclassement est différé puis rejoué. `replayIds` : rejeu d'un reclassement différé (ses identifiants de chunks), qui rend alors
   * `"paused"` s'il est de nouveau refusé.
   */
  private async rerank(rr: RerankerProvider, query: string, candidates: RagHit[], deadlineMs: number, mode: "shadow" | "active", replayIds?: number[], served?: { start: number; servedAt?: number }): Promise<RagHit[] | null | "paused"> {
    const t0 = Date.now();
    const chunkIds = replayIds ?? candidates.map((h) => this.d.db.all<{ id: number }>("SELECT id FROM rag_chunks WHERE doc_id = ? AND ord = ?", h.docId, h.ord)[0]?.id ?? 0);
    try {
      // L'identifiant de la requête de reclassement est la POSITION du candidat (0..N-1) : stable le temps de l'appel.
      const hits = await rr.rerank({ query, candidates: candidates.map((h, i) => ({ id: i, text: h.text })), topN: candidates.length, deadlineMs });
      const order: number[] = [];
      for (const h of hits) if (Number.isInteger(h.id) && h.id >= 0 && h.id < candidates.length && !order.includes(h.id)) order.push(h.id);
      const full = [...order, ...candidates.map((_, i) => i).filter((i) => !order.includes(i))];
      this.report(rr, mode, t0, chunkIds, "ok", full.map((i) => chunkIds[i]!), undefined, served);
      return full.map((i) => candidates[i]!);
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "RERANKER_FAILED";
      if (code === "RERANKER_PAUSED") {
        if (replayIds) return "paused";
        this.report(rr, mode, t0, chunkIds, "paused", [], code, served);
        if (mode === "shadow") {
          this.deferStats.deferred += 1;
          this.defer({ rr, query, candidates, chunkIds, deadlineMs, at: Date.now() });
        }
        return null;
      }
      this.report(rr, mode, t0, chunkIds, code === "RERANKER_TIMEOUT" ? "timeout" : code === "RERANKER_UNAVAILABLE" || code === "RERANKER_BUSY" ? "unavailable" : "error", [], code, served);
      return null;
    }
  }

  /** Removes a document, or everything, from the index. */
  forget(selector?: string): number {
    this.d.index?.invalidate();
    if (!selector) {
      this.d.db.run("DELETE FROM rag_documents");
      return this.d.db.run("DELETE FROM rag_chunks").changes;
    }
    this.d.db.run("DELETE FROM rag_documents WHERE doc_id = ? OR source = ?", selector, selector);
    return this.d.db.run("DELETE FROM rag_chunks WHERE doc_id = ? OR source = ?", selector, selector).changes;
  }
}
