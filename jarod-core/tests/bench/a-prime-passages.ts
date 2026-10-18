/**
 * Bench A' au niveau du PASSAGE : dense / FTS5 / hybride sur les 25 questions de `question test rag.txt`, cibles = passages-réponses
 * VALIDÉS par l'utilisateur (`a-prime-targets.json`). Barres FIGÉES avant toute mesure (DECISIONS 2026-10-01 « Cibles A' … VALIDÉES »,
 * commit cbc4982) : l'hybride est « utile au niveau du passage » seulement si (a) hybride @3 ≥ dense @3 + 2 questions ET (b) MRR hybride
 * ≥ MRR dense. Ligne de base de la gate du reranker. Ne rend que des compteurs, des numéros de question et des scores : aucun texte.
 *
 *     tsx bench/a-prime-passages.ts <dossier-profil-copie> <modelDir> [port]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir, ftsQuery } from "@jarod/plugin-storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DEPTH = 50;
const RRF_K = 60;
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];

interface Target {
  n: number;
  confidence: string;
  answer: string[];
  partial: string[];
}
const norm = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
const rrf = (a: readonly number[], b: readonly number[], limit: number): number[] => {
  const score = new Map<number, number>();
  for (const list of [a, b]) list.forEach((id, r) => { score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + r + 1)); });
  return [...score.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, limit).map(([id]) => id);
};

async function main(): Promise<void> {
  const [dir, modelDir, portArg] = process.argv.slice(2);
  if (!dir || !modelDir) throw new Error("usage : tsx bench/a-prime-passages.ts <dossier-profil-copie> <modelDir> [port]");
  const port = Number(portArg ?? 8920);
  const spec = JSON.parse(readFileSync(join(HERE, "a-prime-targets.json"), "utf8")) as { docs: Record<string, string>; questions: Target[] };
  const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const questions: string[] = [];
  for (const l of lines) if (!HEADERS.some((h) => h.test(l))) questions.push(l);
  if (questions.length !== spec.questions.length) throw new Error(`${questions.length} questions pour ${spec.questions.length} cibles`);

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
    const rows = a.storage.db.all<{ doc_id: string; ord: number; text: string; dim: number; embedding: Buffer }>("SELECT doc_id, ord, text, dim, embedding FROM rag_chunks ORDER BY id");
    const index = new Map(rows.map((r, i) => [`${r.doc_id}#${r.ord}`, i]));
    const resolveId = (s: string): number => {
      const [key, ord] = s.split("#");
      const doc = spec.docs[key!];
      const i = index.get(`${doc}#${ord}`);
      if (i === undefined) throw new Error(`passage introuvable : ${s}`);
      return i;
    };
    const vecs = rows.map((r) => new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.dim * 4)));
    const inv = vecs.map((v) => 1 / norm(v));
    await a.embeddings.host!.ready();
    const qv: Float32Array[] = [];
    for (let i = 0; i < questions.length; i += 16) qv.push(...(await a.embeddings.embed(questions.slice(i, i + 16).map((q) => q)))); // eslint-disable-line
    const fts = new Database(":memory:");
    fts.exec("CREATE VIRTUAL TABLE fts USING fts5(text, content='', tokenize='unicode61 remove_diacritics 2')");
    const ins = fts.prepare("INSERT INTO fts(rowid, text) VALUES (?, ?)");
    rows.forEach((r, i) => { ins.run(i + 1, r.text); });
    const stmt = fts.prepare(`SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ${DEPTH}`);

    type M = "dense" | "fts" | "hybrid";
    const ranks: Record<M, Record<number, number | null>> = { dense: {}, fts: {}, hybrid: {} };
    const ranksWithPartial: Record<M, Record<number, number | null>> = { dense: {}, fts: {}, hybrid: {} };
    const top1Scores: Record<number, number> = {};
    questions.forEach((_, qi) => {
      const t = spec.questions[qi]!;
      const v = qv[qi]!;
      const qn = 1 / norm(v);
      const scored = vecs
        .map((c, i) => {
          let d = 0;
          for (let j = 0; j < v.length; j++) d += v[j]! * c[j]!;
          return [d * qn * inv[i]!, i] as const;
        })
        .sort((x, y) => y[0] - x[0] || x[1] - y[1]);
      top1Scores[t.n] = Number(scored[0]![0].toFixed(4));
      const dense = scored.slice(0, DEPTH).map(([, i]) => i);
      const fq = ftsQuery(questions[qi]!, "or");
      const f = fq ? (stmt.all(fq) as { rowid: number }[]).map((r) => r.rowid - 1) : [];
      const hybrid = rrf(dense, f, 10);
      const ans = new Set(t.answer.map(resolveId));
      const both = new Set([...t.answer, ...t.partial].map(resolveId));
      const rank = (list: number[], set: Set<number>): number | null => {
        const p = list.findIndex((id) => set.has(id));
        return p >= 0 ? p + 1 : null;
      };
      for (const [m, list] of [["dense", dense], ["fts", f], ["hybrid", hybrid]] as const) {
        ranks[m][t.n] = ans.size ? rank(list, ans) : null;
        ranksWithPartial[m][t.n] = both.size ? rank(list, both) : null;
      }
    });

    const scoredQs = spec.questions.filter((q) => q.answer.length > 0).map((q) => q.n);
    const noAnswer = spec.questions.filter((q) => q.answer.length === 0).map((q) => q.n);
    const stats = (r: Record<number, number | null>, ns: number[]) => ({
      at1: ns.filter((n) => r[n] !== null && r[n]! <= 1).length,
      at3: ns.filter((n) => r[n] !== null && r[n]! <= 3).length,
      at10: ns.filter((n) => r[n] !== null && r[n]! <= 10).length,
      mrr: Number((ns.reduce((s, n) => s + (r[n] ? 1 / r[n]! : 0), 0) / ns.length).toFixed(4)),
    });
    const res = {
      n: scoredQs.length,
      answer: { dense: stats(ranks.dense, scoredQs), fts: stats(ranks.fts, scoredQs), hybrid: stats(ranks.hybrid, scoredQs) },
      withPartial: (() => {
        const ns = spec.questions.filter((q) => q.answer.length + q.partial.length > 0).map((q) => q.n);
        return { n: ns.length, dense: stats(ranksWithPartial.dense, ns), fts: stats(ranksWithPartial.fts, ns), hybrid: stats(ranksWithPartial.hybrid, ns) };
      })(),
    };
    const sorted = (xs: number[]) => [...xs].sort((x, y) => x - y);
    const med = (xs: number[]) => sorted(xs)[xs.length >> 1]!;
    const abstention = { noAnswerTop1: Object.fromEntries(noAnswer.map((n) => [n, top1Scores[n]])), medianTop1OfScored: med(scoredQs.map((n) => top1Scores[n]!)), minTop1OfScored: Math.min(...scoredQs.map((n) => top1Scores[n]!)) };
    const a3 = res.answer.hybrid.at3 >= res.answer.dense.at3 + 2;
    const b = res.answer.hybrid.mrr >= res.answer.dense.mrr;
    const verdict = a3 && b ? "utile au niveau du passage" : "non démontré";
    const reasons = [a3 ? "" : `(a) hybride @3 ${res.answer.hybrid.at3} < dense @3 ${res.answer.dense.at3} + 2`, b ? "" : `(b) MRR hybride ${res.answer.hybrid.mrr} < dense ${res.answer.dense.mrr}`].filter(Boolean);
    const report = { at: new Date().toISOString(), chunks: rows.length, res, ranks, abstention, verdict, reasons };
    mkdirSync(join(ROOT, ".work"), { recursive: true });
    const file = join(ROOT, ".work", `a-prime-passages-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    const f = (s: { at1: number; at3: number; at10: number; mrr: number }, n: number) => `@1 ${s.at1}/${n}  @3 ${s.at3}/${n}  @10 ${s.at10}/${n}  MRR ${s.mrr}`;
    console.log(`passages ${rows.length} ; questions notées ${res.n} ; sans réponse ${noAnswer.join(",")}`);
    for (const m of ["dense", "fts", "hybrid"] as const) console.log(` ${m.padEnd(7)} ${f(res.answer[m], res.n)}`);
    console.log(`avec 'partial' comme réponse (n=${res.withPartial.n}) :`);
    for (const m of ["dense", "fts", "hybrid"] as const) console.log(` ${m.padEnd(7)} ${f(res.withPartial[m], res.withPartial.n)}`);
    console.log("rang du 1er passage-réponse (dense | fts | hybride), '-' = hors des 50 / 10 :");
    for (const n of scoredQs) console.log(`  Q${String(n).padStart(2)} ${String(ranks.dense[n] ?? "-").padStart(3)} | ${String(ranks.fts[n] ?? "-").padStart(3)} | ${String(ranks.hybrid[n] ?? "-").padStart(3)}`);
    console.log("abstention :", JSON.stringify(abstention));
    console.log(`\nVERDICT (passage) : ${verdict}${reasons.length ? "\n  - " + reasons.join("\n  - ") : ""}\nrapport : ${file}`);
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
