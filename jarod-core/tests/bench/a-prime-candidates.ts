/**
 * Candidats de passages-réponses pour les questions de `question test rag.txt` : pour chaque question, l'union des 6 premiers du dense
 * exact et des 6 premiers de FTS5 (méthodes de C0-b). Sert à CHOISIR puis FAIRE VALIDER par l'utilisateur la cible au niveau du
 * PASSAGE (identifiant stable = document + ordre). Écrit `.work/a-prime-candidates.json` (CONTIENT du texte de documents : dossier
 * ignoré par git, ne jamais le committer ni le copier dans un rapport).
 *
 *     tsx bench/a-prime-candidates.ts <dossier-profil-copie> <modelDir> [port]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir, ftsQuery } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PER_METHOD = 6;
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];
const norm = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;

async function main(): Promise<void> {
  const [dir, modelDir, portArg] = process.argv.slice(2);
  if (!dir || !modelDir) throw new Error("usage : tsx bench/a-prime-candidates.ts <dossier-profil-copie> <modelDir> [port]");
  const port = Number(portArg ?? 8920);
  const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const questions: { n: number; theme: number; text: string }[] = [];
  let theme = -1;
  for (const l of lines) {
    const t = HEADERS.findIndex((h) => h.test(l));
    if (t >= 0) { theme = t; continue; }
    questions.push({ n: questions.length + 1, theme, text: l });
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
    const rows = a.storage.db.all<{ doc_id: string; ord: number; text: string; dim: number; embedding: Buffer }>("SELECT doc_id, ord, text, dim, embedding FROM rag_chunks ORDER BY id");
    const vecs = rows.map((r) => new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.dim * 4)));
    const inv = vecs.map((v) => 1 / norm(v));
    await a.embeddings.host!.ready();
    const qv: Float32Array[] = [];
    for (let i = 0; i < questions.length; i += 16) qv.push(...(await a.embeddings.embed(questions.slice(i, i + 16).map((q) => q.text))));
    const fts = new Database(":memory:");
    fts.exec("CREATE VIRTUAL TABLE fts USING fts5(text, content='', tokenize='unicode61 remove_diacritics 2')");
    const ins = fts.prepare("INSERT INTO fts(rowid, text) VALUES (?, ?)");
    rows.forEach((r, i) => ins.run(i + 1, r.text));
    const stmt = fts.prepare(`SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ${PER_METHOD}`);
    const out = questions.map((q, qi) => {
      const v = qv[qi]!;
      const qn = 1 / norm(v);
      const dense = rows
        .map((_, i) => {
          let d = 0;
          for (let j = 0; j < v.length; j++) d += v[j]! * vecs[i]![j]!;
          return [d * qn * inv[i]!, i] as const;
        })
        .sort((x, y) => y[0] - x[0] || x[1] - y[1])
        .slice(0, PER_METHOD)
        .map(([, i]) => i);
      const fq = ftsQuery(q.text, "or");
      const f = fq ? (stmt.all(fq) as { rowid: number }[]).map((r) => r.rowid - 1) : [];
      const ids = [...new Set([...dense, ...f])];
      return { ...q, candidates: ids.map((i) => ({ passage: `${rows[i]!.doc_id}#${rows[i]!.ord}`, viaDense: dense.includes(i), viaFts: f.includes(i), text: rows[i]!.text })) };
    });
    mkdirSync(join(ROOT, ".work"), { recursive: true });
    const file = join(ROOT, ".work", "a-prime-candidates.json");
    writeFileSync(file, JSON.stringify(out, null, 1));
    console.log(`${out.length} questions, ${out.reduce((s, q) => s + q.candidates.length, 0)} candidats -> ${file}`);
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
