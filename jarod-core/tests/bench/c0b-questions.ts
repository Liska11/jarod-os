/**
 * Bench A' : dense / FTS5 / hybride sur de VRAIES questions (`question test rag.txt`, fournies par l'utilisateur).
 * Règle de ciblage et barre FIGÉES avant toute mesure (DECISIONS 2026-10-01 « Jeu A' », commit 069acf6) : cible DÉDUITE par l'agent
 * au niveau du document, d'après l'intitulé du thème ; thème sans cible déduite = relevé mais exclu du verdict. Une seule barre :
 * hybride ≥ dense en succès @3. Ne rend que des compteurs et des noms de fichiers : aucun texte de document.
 *
 *     tsx bench/c0b-questions.ts <dossier-profil-copie> <modelDir> [port]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir, ftsQuery } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEPTH = 50;
const RRF_K = 60;

/** Intitulé de thème (début de ligne) → document cible déduit ; null = pas de cible déduite (exclu du verdict). */
const THEMES: { header: RegExp; target: string | null }[] = [
  { header: /^Réseau RMP/, target: "Présentation du réseau RMP - 16-09-2024_PJ1.pptx" },
  { header: /^Matrice d'escalade/, target: "GSM-R_MATRICE_ESCALADE.xlsx" },
  { header: /^GTB & Supervision/, target: "Formations SNCF - Module 84 - GTB_PJ1.pptx" },
  { header: /^Procédures & Incidents/, target: null },
];

const norm = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
const rrf = (a: readonly number[], b: readonly number[], limit: number): number[] => {
  const score = new Map<number, number>();
  for (const list of [a, b]) list.forEach((id, r) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + r + 1)));
  return [...score.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, limit).map(([id]) => id);
};

async function main(): Promise<void> {
  const [dir, modelDir, portArg] = process.argv.slice(2);
  if (!dir || !modelDir) throw new Error("usage : tsx bench/c0b-questions.ts <dossier-profil-copie> <modelDir> [port]");
  const port = Number(portArg ?? 8920);
  const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const questions: { text: string; theme: number }[] = [];
  let theme = -1;
  for (const l of lines) {
    const t = THEMES.findIndex((x) => x.header.test(l));
    if (t >= 0) { theme = t; continue; }
    if (theme < 0) throw new Error(`question avant tout intitulé de thème : ligne inattendue`);
    questions.push({ text: l, theme });
  }

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
    const rows = a.storage.db.all<{ doc_id: string; text: string; dim: number; embedding: Buffer }>("SELECT doc_id, text, dim, embedding FROM rag_chunks ORDER BY id");
    const vecs = rows.map((r) => new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.dim * 4)));
    const inv = vecs.map((v) => 1 / norm(v));
    if (!a.embeddings.host) throw new Error("worker d'embeddings non lancé");
    await a.embeddings.host.ready();
    const qv: Float32Array[] = [];
    for (let i = 0; i < questions.length; i += 16) qv.push(...(await a.embeddings.embed(questions.slice(i, i + 16).map((q) => q.text))));

    const fts = new Database(":memory:");
    fts.exec("CREATE VIRTUAL TABLE fts USING fts5(text, content='', tokenize='unicode61 remove_diacritics 2')");
    const ins = fts.prepare("INSERT INTO fts(rowid, text) VALUES (?, ?)");
    rows.forEach((r, i) => ins.run(i + 1, r.text));
    const stmt = fts.prepare(`SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ${DEPTH}`);

    type Tally = { n: number; dense: number[]; fts: number[]; hybrid: number[] };
    const tallies = THEMES.map((): Tally => ({ n: 0, dense: [0, 0, 0], fts: [0, 0, 0], hybrid: [0, 0, 0] }));
    const topDocs: Record<string, number>[] = THEMES.map(() => ({}));
    questions.forEach((q, qi) => {
      const v = qv[qi]!;
      const qn = 1 / norm(v);
      const scores = vecs.map((c, i) => {
        let d = 0;
        for (let j = 0; j < v.length; j++) d += v[j]! * c[j]!;
        return d * qn * inv[i]!;
      });
      const dense = scores.map((s, i) => [s, i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, DEPTH).map(([, i]) => i);
      const fq = ftsQuery(q.text, "or");
      const f = fq ? (stmt.all(fq) as { rowid: number }[]).map((r) => r.rowid - 1) : [];
      const hybrid = rrf(dense, f, 10);
      const t = tallies[q.theme]!;
      t.n++;
      const target = THEMES[q.theme]!.target;
      if (target) {
        const tally = (list: number[], out: number[]) => {
          const p = list.findIndex((id) => rows[id]!.doc_id === target);
          if (p >= 0 && p < 1) out[0]!++;
          if (p >= 0 && p < 3) out[1]!++;
          if (p >= 0 && p < 10) out[2]!++;
        };
        tally(dense, t.dense);
        tally(f, t.fts);
        tally(hybrid, t.hybrid);
      } else {
        const d1 = rows[hybrid[0]!]?.doc_id ?? "(rien)";
        topDocs[q.theme]![d1] = (topDocs[q.theme]![d1] ?? 0) + 1;
      }
    });

    const scored = tallies.filter((_, i) => THEMES[i]!.target);
    const sum = (k: "dense" | "fts" | "hybrid", at: number) => scored.reduce((s, t) => s + t[k][at]!, 0);
    const n = scored.reduce((s, t) => s + t.n, 0);
    const pass = sum("hybrid", 1) >= sum("dense", 1);
    const report = { at: new Date().toISOString(), chunks: rows.length, n, dense: [0, 1, 2].map((i) => sum("dense", i)), fts: [0, 1, 2].map((i) => sum("fts", i)), hybrid: [0, 1, 2].map((i) => sum("hybrid", i)), tallies, topDocsExcluded: topDocs, barreA: pass };
    mkdirSync(join(ROOT, ".work"), { recursive: true });
    const file = join(ROOT, ".work", `c0b-questions-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`passages ${rows.length} ; questions notées ${n} (+ ${questions.length - n} sans cible déduite, exclues)`);
    THEMES.forEach((th, i) => {
      const t = tallies[i]!;
      if (th.target) console.log(` thème ${i + 1} (${t.n}) → ${th.target.slice(0, 30)}…\n   dense   @1 ${t.dense[0]} @3 ${t.dense[1]} @10 ${t.dense[2]}\n   fts5    @1 ${t.fts[0]} @3 ${t.fts[1]} @10 ${t.fts[2]}\n   hybride @1 ${t.hybrid[0]} @3 ${t.hybrid[1]} @10 ${t.hybrid[2]}`);
      else console.log(` thème ${i + 1} (${t.n}) sans cible : documents en 1re place (hybride) ${JSON.stringify(topDocs[i])}`);
    });
    console.log(`TOTAL sur ${n} : dense @1/@3/@10 = ${report.dense.join("/")} ; fts5 = ${report.fts.join("/")} ; hybride = ${report.hybrid.join("/")}`);
    console.log(`\nBARRE (A') hybride @3 ≥ dense @3 : ${pass ? "TENUE" : "MANQUÉE"}\nrapport : ${file}`);
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
