/**
 * Bench C0-a : recherche hybride dense + FTS5/BM25 contre dense seul, sur le corpus Q15 (10⁴ et 10⁵ chunks, vecteurs
 * bge-m3 INT8 déjà calculés) et les trois jeux de requêtes A (24 P2), B (176 extraits), D (200 mots-clés).
 * Critère et barres FIGÉS avant toute mesure (DECISIONS 2026-09-29 « Ingestion, C0 ») ; verdict : `c0-verdict.ts`.
 *
 * Méthodes (une seule configuration de chacune) : DENSE = cosinus exact sur les vecteurs stockés ; FTS5 = table sans
 * contenu `unicode61 remove_diacritics 2`, requête `ftsQuery(texte, "or")` de plugin-storage telle quelle, tri bm25,
 * 50 premiers ; HYBRIDE = RRF (k = 60) des 50 premiers de chaque, 10 premiers rendus.
 *
 * Chaque passage est un PROCESSUS NEUF (3 par défaut) : les rappels sont déterministes, le p95 du volet FTS5 est la
 * médiane des passages. Volet FTS5 chronométré = requête préparée + lecture des lignes ; les 20 premières requêtes
 * (échauffement) sont écartées. Machine calme exigée par l'appelant (rien n'est lancé en parallèle).
 *
 *     pnpm --filter @jarod/gates bench:c0
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { ftsQuery } from "@jarod/plugin-storage";
import { C0_DIR, type KeywordQuery } from "./c0-corpus.js";
import { c0Verdict, C0_SIZES, type C0Run, type Recall, type SetResult } from "./c0-verdict.js";
import { DIM, Q15_DIR, type Chunk, type Query } from "./q15-corpus.js";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "../..");
const REPS = Number(process.env.C0_REPS ?? 3);
const DEPTH = 50;
const RRF_K = 60;
const WARMUP = 20;

interface Item {
  set: "A" | "B" | "D";
  text: string;
  vector: Float32Array;
  /** Indices de chunks réussissant la requête. */
  ok: Set<number>;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

/** Les k meilleurs (score décroissant) sans trier tout : insertion dans une petite liste triée. */
function topK(scores: Float32Array, k: number): number[] {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    if (idx.length === k && s <= val[k - 1]!) continue;
    let p = idx.length < k ? idx.length : k - 1;
    while (p > 0 && val[p - 1]! < s) {
      if (p < k) {
        idx[p] = idx[p - 1]!;
        val[p] = val[p - 1]!;
      }
      p--;
    }
    idx[p] = i;
    val[p] = s;
  }
  return idx;
}

function loadItems(): { items: Item[]; chunkVectors: Float32Array; chunks: Chunk[] } {
  const chunks = readFileSync(join(Q15_DIR, "chunks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Chunk);
  const queries = JSON.parse(readFileSync(join(Q15_DIR, "queries.json"), "utf8")) as Query[];
  const buf = readFileSync(join(Q15_DIR, "vectors.f32"));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const rows = (i: number) => all.subarray(i * DIM, (i + 1) * DIM);
  const items: Item[] = [];
  queries.forEach((q, i) => {
    if (q.kind === "heldout") return;
    items.push({ set: q.kind === "p2" ? "A" : "B", text: q.text, vector: rows(i), ok: new Set([q.target!]) });
  });
  const kw = JSON.parse(readFileSync(join(C0_DIR, "keyword-queries.json"), "utf8")) as KeywordQuery[];
  const kv = readFileSync(join(C0_DIR, "keyword-vectors.f32"));
  const kvf = new Float32Array(kv.buffer, kv.byteOffset, kv.byteLength / 4);
  if (kvf.length !== kw.length * DIM) throw new Error("vecteurs des requêtes D incomplets : lancer bench:c0-corpus");
  kw.forEach((k, i) => { items.push({ set: "D", text: k.text, vector: kvf.subarray(i * DIM, (i + 1) * DIM), ok: new Set(k.acceptable) }); });
  const chunkVectors = all.subarray(queries.length * DIM);
  return { items, chunkVectors, chunks };
}

function norm(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s) || 1;
}

function buildFts(chunks: readonly Chunk[], size: number, path: string): { db: Database.Database; buildMs: number; bytes: number } {
  rmSync(path, { force: true });
  const db = new Database(path);
  db.pragma("journal_mode = OFF");
  db.pragma("synchronous = OFF");
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(text, content='', tokenize='unicode61 remove_diacritics 2')");
  const t0 = performance.now();
  const ins = db.prepare("INSERT INTO fts(rowid, text) VALUES (?, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < size; i++) ins.run(i + 1, chunks[i]!.text);
  db.exec("COMMIT");
  db.close();
  const buildMs = performance.now() - t0;
  const ro = new Database(path, { readonly: true });
  return { db: ro, buildMs, bytes: statSync(path).size };
}

function rrf(a: readonly number[], b: readonly number[], limit: number): number[] {
  const score = new Map<number, number>();
  for (const list of [a, b]) list.forEach((id, r) => { score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + r + 1)); });
  return [...score.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, limit).map(([id]) => id);
}

function once(): void {
  const { items, chunkVectors, chunks } = loadItems();
  const out: { size: number; sets: Record<string, SetResult>; ftsP95Ms: number; ftsP50Ms: number; ftsBytes: number; ftsBuildMs: number; queries: number }[] = [];
  for (const size of C0_SIZES) {
    const inv = new Float32Array(size);
    for (let i = 0; i < size; i++) inv[i] = 1 / norm(chunkVectors.subarray(i * DIM, (i + 1) * DIM));
    const dbPath = join(C0_DIR, "tmp", `fts-${size}.db`);
    mkdirSync(dirname(dbPath), { recursive: true });
    const { db, buildMs, bytes } = buildFts(chunks, size, dbPath);
    const stmt = db.prepare(`SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ${DEPTH}`);
    const sets: Record<string, SetResult> = {};
    const zero = (): Recall => ({ at1: 0, at3: 0, at10: 0 });
    for (const s of ["A", "B", "D"]) sets[s] = { n: 0, dense: zero(), fts: zero(), hybrid: zero() };
    const ftsMs: number[] = [];
    const scores = new Float32Array(size);
    for (const it of items) {
      // dense exact
      const qn = 1 / norm(it.vector);
      for (let i = 0; i < size; i++) {
        const o = i * DIM;
        let d = 0;
        for (let j = 0; j < DIM; j++) d += it.vector[j]! * chunkVectors[o + j]!;
        scores[i] = d * qn * inv[i]!;
      }
      const dense = topK(scores, DEPTH);
      // volet FTS5 chronométré
      const fq = ftsQuery(it.text, "or");
      let fts: number[] = [];
      const t0 = performance.now();
      if (fq) fts = (stmt.all(fq) as { rowid: number }[]).map((r) => r.rowid - 1);
      ftsMs.push(performance.now() - t0);
      const hybrid = rrf(dense, fts, 10);
      const res = sets[it.set]!;
      res.n++;
      const score = (list: number[], r: Recall) => {
        const first = list.findIndex((id) => it.ok.has(id) && id < size);
        if (first >= 0 && first < 1) r.at1++;
        if (first >= 0 && first < 3) r.at3++;
        if (first >= 0 && first < 10) r.at10++;
      };
      score(dense, res.dense);
      score(fts, res.fts);
      score(hybrid, res.hybrid);
    }
    db.close();
    const timed = ftsMs.slice(WARMUP);
    out.push({ size, sets, ftsP95Ms: pct(timed, 95), ftsP50Ms: pct(timed, 50), ftsBytes: bytes, ftsBuildMs: Math.round(buildMs), queries: items.length });
    rmSync(dbPath, { force: true });
  }
  console.log("C0RESULT " + JSON.stringify(out));
}

function pass(): Promise<ReturnType<typeof JSON.parse>> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--max-old-space-size=8192", "--import", "tsx", HERE, "--once"], { stdio: ["ignore", "pipe", "inherit"], cwd: dirname(HERE) });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.on("exit", (code) => {
      const line = buf.split("\n").find((l) => l.startsWith("C0RESULT "));
      if (code !== 0 || !line) return rej(new Error(`passage échoué (code ${code})`));
      res(JSON.parse(line.slice(9)));
    });
  });
}

async function main(): Promise<void> {
  const passes: Awaited<ReturnType<typeof pass>>[] = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    passes.push(await pass());
    console.log(`[c0] passage ${i + 1}/${REPS} en ${Math.round((performance.now() - t0) / 1000)} s`);
  }
  const runs: C0Run[] = C0_SIZES.map((size) => {
    const per = passes.map((p) => p.find((r: { size: number }) => r.size === size)!);
    for (const p of per) if (JSON.stringify(p.sets) !== JSON.stringify(per[0].sets)) throw new Error(`rappels non déterministes à ${size}`);
    return { size, A: per[0].sets.A, B: per[0].sets.B, D: per[0].sets.D, ftsP95Ms: per.map((p: { ftsP95Ms: number }) => p.ftsP95Ms) };
  });
  const verdict = c0Verdict(runs);
  const report = { at: new Date().toISOString(), reps: REPS, depth: DEPTH, rrfK: RRF_K, runs, verdict, detail: passes };
  mkdirSync(join(ROOT, ".work"), { recursive: true });
  const file = join(ROOT, ".work", `c0-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  const fmt = (r: Recall, n: number) => `@1 ${r.at1}/${n}  @3 ${r.at3}/${n}  @10 ${r.at10}/${n}`;
  for (const run of runs) {
    console.log(`\n== ${run.size} chunks ==`);
    for (const s of ["A", "B", "D"] as const) {
      const r = run[s];
      console.log(` ${s} (${r.n})\n   dense  ${fmt(r.dense, r.n)}\n   fts5   ${fmt(r.fts, r.n)}\n   hybride ${fmt(r.hybrid, r.n)}`);
    }
    const first = passes[0].find((r: { size: number }) => r.size === run.size);
    console.log(` volet FTS5 : p95 ${run.ftsP95Ms.map((x) => x.toFixed(2)).join(" / ")} ms (passages) ; p50 ${first.ftsP50Ms.toFixed(2)} ms ; index ${(first.ftsBytes / 1048576).toFixed(1)} Mo ; construction ${first.ftsBuildMs} ms`);
  }
  console.log(`\nVERDICT : ${verdict.verdict}${verdict.reasons.length ? "\n  - " + verdict.reasons.join("\n  - ") : ""}\nrapport : ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  if (process.argv.includes("--once")) once();
  else
    main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
