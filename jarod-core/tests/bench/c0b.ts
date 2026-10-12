/**
 * Bench C0-b : recherche hybride dense + FTS5/BM25 contre dense seul, sur les documents FRANÇAIS réels indexés dans un profil.
 * Critères et barres FIGÉS avant toute mesure (DECISIONS 2026-10-01 « Ingestion, C0-b », commit 1a69088) ; mêmes méthodes que C0-a
 * (`c0.ts`) : DENSE = cosinus exact sur les vecteurs stockés ; FTS5 = `unicode61 remove_diacritics 2`, `ftsQuery(texte, "or")`, bm25,
 * 50 premiers ; HYBRIDE = RRF (k = 60), 10 rendus. Jeux : B' (extraits verbatim [100 ; 300) des passages éligibles) et D'
 * (trois jetons rares, df ∈ [1 ; 20]) ; pas de jeu A' (aucune section dans les manifestes).
 *
 * Lit une COPIE de la base d'un profil (jamais le profil servi) et démarre le worker d'embeddings pour les vecteurs des requêtes.
 * Ne rend que des compteurs : aucun texte de document dans la sortie ni dans le rapport.
 *
 *     tsx bench/c0b.ts <dossier-profil-copie> <modelDir> [port]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir, ftsQuery } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEPTH = 50;
const RRF_K = 60;
const ELIGIBLE = 400;
const MAX_QUERIES = 200;
const MIN_QUERIES = 40;
const GAIN_POINTS = 5;

interface Chunk {
  id: number;
  doc: string;
  text: string;
  vector: Float32Array;
}
interface Query {
  set: "B" | "D";
  text: string;
  /** Indices (dans `chunks`) des passages qui réussissent la requête. */
  ok: Set<number>;
}
interface Recall {
  at1: number;
  at3: number;
  at10: number;
}

const strip = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const norm = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;

function topK(scores: number[], k: number): number[] {
  return scores
    .map((s, i) => [s, i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, k)
    .map(([, i]) => i);
}

function rrf(a: readonly number[], b: readonly number[], limit: number): number[] {
  const score = new Map<number, number>();
  for (const list of [a, b]) list.forEach((id, r) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + r + 1)));
  return [...score.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, limit).map(([id]) => id);
}

function buildQueries(chunks: readonly Chunk[]): Query[] {
  const eligible = chunks.map((c, i) => [c, i] as const).filter(([c]) => c.text.length >= ELIGIBLE);
  const out: Query[] = [];
  // B' : extrait verbatim [100 ; 300) (espaces normalisées).
  let nb = 0;
  for (const [c] of eligible) {
    if (nb >= MAX_QUERIES) break;
    const ext = c.text.replace(/\s+/g, " ").slice(100, 300).trim();
    if (ext.length < 100) continue;
    const norm1 = (s: string) => s.replace(/\s+/g, " ");
    const ok = new Set<number>();
    chunks.forEach((x, i) => {
      if (norm1(x.text).includes(ext)) ok.add(i);
    });
    out.push({ set: "B", text: ext, ok });
    nb++;
  }
  // D' : trois jetons rares (df ∈ [1 ; 20]), règle D de C0-a.
  const tokens = chunks.map((c) => new Set(strip(c.text).match(/[\p{L}\p{N}]{5,}/gu) ?? []));
  const df = new Map<string, number>();
  for (const set of tokens) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  let nd = 0;
  for (const [, i] of eligible) {
    if (nd >= MAX_QUERIES) break;
    const rare = [...tokens[i]!].filter((t) => df.get(t)! >= 1 && df.get(t)! <= 20).sort((a, b) => df.get(a)! - df.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    if (rare.length < 3) continue;
    const q = rare.slice(0, 3);
    const ok = new Set<number>();
    tokens.forEach((set, j) => {
      if (q.every((t) => set.has(t))) ok.add(j);
    });
    out.push({ set: "D", text: q.join(" "), ok });
    nd++;
  }
  return out;
}

async function main(): Promise<void> {
  const [dir, modelDir, portArg] = process.argv.slice(2);
  if (!dir || !modelDir) throw new Error("usage : tsx bench/c0b.ts <dossier-profil-copie> <modelDir> [port]");
  const port = Number(portArg ?? 8920);
  const app = new JarodApp({
    plugins: {
      storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) },
      llm: {},
      embeddings: { modelDir, port, isolation: {} },
      rag: { embeddingsDefaultUrl: `http://127.0.0.1:${port}/v1` },
    },
  } as never);
  const started = await start(app);
  const a = app as unknown as { storage: { db: { all<T>(sql: string): T[] } }; embeddings: { host: { ready(): Promise<void> } | null; embed(t: string[]): Promise<Float32Array[]> } };
  try {
    const rows = a.storage.db.all<{ id: number; doc_id: string; text: string; dim: number; embedding: Buffer }>("SELECT id, doc_id, text, dim, embedding FROM rag_chunks ORDER BY id");
    const chunks: Chunk[] = rows.map((r) => ({
      id: r.id,
      doc: r.doc_id,
      text: r.text,
      vector: new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.dim * 4)),
    }));
    const queries = buildQueries(chunks);
    const sizes = { B: queries.filter((q) => q.set === "B").length, D: queries.filter((q) => q.set === "D").length };
    if (!a.embeddings.host) throw new Error("worker d'embeddings non lancé (rag.enabled faux dans la copie ?)");
    await a.embeddings.host.ready();
    const vectors: Float32Array[] = [];
    for (let i = 0; i < queries.length; i += 16) vectors.push(...(await a.embeddings.embed(queries.slice(i, i + 16).map((q) => q.text))));

    const fts = new Database(":memory:");
    fts.exec("CREATE VIRTUAL TABLE fts USING fts5(text, content='', tokenize='unicode61 remove_diacritics 2')");
    const ins = fts.prepare("INSERT INTO fts(rowid, text) VALUES (?, ?)");
    chunks.forEach((c, i) => ins.run(i + 1, c.text));
    const stmt = fts.prepare(`SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ${DEPTH}`);
    const inv = chunks.map((c) => 1 / norm(c.vector));

    const zero = (): Recall => ({ at1: 0, at3: 0, at10: 0 });
    const res = {
      B: { n: sizes.B, dense: zero(), fts: zero(), hybrid: zero() },
      D: { n: sizes.D, dense: zero(), fts: zero(), hybrid: zero() },
    };
    const perDoc: Record<string, { n: number; dense3: number; fts3: number; hybrid3: number }> = {};
    queries.forEach((q, qi) => {
      const v = vectors[qi]!;
      const qn = 1 / norm(v);
      const dense = topK(chunks.map((c, i) => {
        let d = 0;
        for (let j = 0; j < v.length; j++) d += v[j]! * c.vector[j]!;
        return d * qn * inv[i]!;
      }), DEPTH);
      const fq = ftsQuery(q.text, "or");
      const f = fq ? (stmt.all(fq) as { rowid: number }[]).map((r) => r.rowid - 1) : [];
      const hybrid = rrf(dense, f, 10);
      const rank = (list: number[]) => list.findIndex((id) => q.ok.has(id));
      const tally = (list: number[], r: Recall) => {
        const p = rank(list);
        if (p >= 0 && p < 1) r.at1++;
        if (p >= 0 && p < 3) r.at3++;
        if (p >= 0 && p < 10) r.at10++;
      };
      tally(dense, res[q.set].dense);
      tally(f, res[q.set].fts);
      tally(hybrid, res[q.set].hybrid);
      const doc = chunks[[...q.ok][0] ?? 0]?.doc ?? "?";
      const d = (perDoc[`${q.set}:${doc}`] ??= { n: 0, dense3: 0, fts3: 0, hybrid3: 0 });
      d.n++;
      const in3 = (list: number[]) => (rank(list) >= 0 && rank(list) < 3 ? 1 : 0);
      d.dense3 += in3(dense);
      d.fts3 += in3(f);
      d.hybrid3 += in3(hybrid);
    });

    const reasons: string[] = [];
    let incomplete = false;
    for (const s of ["B", "D"] as const) if (res[s].n < MIN_QUERIES) {
      incomplete = true;
      reasons.push(`jeu ${s}' : ${res[s].n} requêtes < ${MIN_QUERIES} (incomplet)`);
    }
    if (res.B.hybrid.at3 < res.B.dense.at3) reasons.push(`(a) régression sur B' — hybride @3 ${res.B.hybrid.at3} < dense @3 ${res.B.dense.at3} (sur ${res.B.n})`);
    if ((res.D.hybrid.at10 - res.D.dense.at10) * 100 < GAIN_POINTS * res.D.n)
      reasons.push(`(b) gain sur D' insuffisant — rappel@10 hybride ${res.D.hybrid.at10}/${res.D.n} contre dense ${res.D.dense.at10}/${res.D.n} (écart < ${GAIN_POINTS} points)`);
    const verdict = incomplete ? "incomplet" : reasons.length ? "non utile" : "utile";

    const report = { at: new Date().toISOString(), chunks: chunks.length, documents: new Set(chunks.map((c) => c.doc)).size, depth: DEPTH, rrfK: RRF_K, res, perDoc, verdict, reasons };
    mkdirSync(join(ROOT, ".work"), { recursive: true });
    const file = join(ROOT, ".work", `c0b-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    const fmt = (r: Recall, n: number) => `@1 ${r.at1}/${n}  @3 ${r.at3}/${n}  @10 ${r.at10}/${n}`;
    console.log(`passages ${chunks.length} (${report.documents} documents), requêtes B' ${sizes.B}, D' ${sizes.D}`);
    for (const s of ["B", "D"] as const) console.log(` ${s}'\n   dense   ${fmt(res[s].dense, res[s].n)}\n   fts5    ${fmt(res[s].fts, res[s].n)}\n   hybride ${fmt(res[s].hybrid, res[s].n)}`);
    console.log("par document (@3, sur n requêtes) :");
    for (const [k, d] of Object.entries(perDoc).sort()) console.log(`   ${k.slice(0, 2)}${k.slice(2).replace(/[^\w.]+/g, "_").slice(0, 28)} n=${d.n} dense ${d.dense3} fts ${d.fts3} hybride ${d.hybrid3}`);
    console.log(`\nVERDICT : ${verdict}${reasons.length ? "\n  - " + reasons.join("\n  - ") : ""}\nrapport : ${file}`);
  } finally {
    await stop(started);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
