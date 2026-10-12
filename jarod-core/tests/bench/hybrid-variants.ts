/**
 * EXPLORATOIRE, POST HOC, HORS BARRES (DECISIONS 2026-10-01 « rag.hybrid : RÉSULTAT DE LA GATE ») : la barre (a) a été manquée par la règle figée
 * (égalité RRF → meilleur rang dense). Ce script chiffre, SANS rien changer au code livré, deux variantes de la fusion pour éclairer la décision de
 * l'utilisateur ; il ne remplace aucune barre et ne règle rien. Il rejoue la chaîne hors du service : classement dense exact (cosinus), liste FTS5
 * (`ftsQuery(texte, "or")`, bm25, 50), fusion, plafond par document (2), puis les mêmes jeux que `hybrid-gate.ts`. La variante V0 est la règle
 * figée : ses chiffres DOIVENT retrouver ceux de la gate (contrôle de fidélité du banc).
 *     tsx bench/hybrid-variants.ts <dossier-profil-copie> [--port 8920]
 *   V0 : règle figée (égalité → meilleur rang dense) ;  V1 : égalité → meilleur rang lexical ;  V2 : poids 2 sur le rang lexical (k = 60).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir, ftsQuery } from "@jarod/plugin-storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EMB_MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];
const DEPTH = 50;
const RRF_K = 60;
const PER_DOC = 2;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

interface Row { id: number; doc_id: string; ord: number; text: string; dim: number; embedding: Buffer; source: string | null }
const k = (r: { doc_id: string; ord: number }) => `${r.doc_id}#${r.ord}`;
const cos = (a: Float32Array, b: Float32Array): number => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
const floats = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

type Variant = "V0" | "V1" | "V2";
function fuse(dense: string[], lex: string[], v: Variant): string[] {
  const wl = v === "V2" ? 2 : 1;
  const score = new Map<string, number>();
  const dr = new Map<string, number>();
  const lr = new Map<string, number>();
  dense.slice(0, DEPTH).forEach((id, r) => { score.set(id, 1 / (RRF_K + r + 1)); dr.set(id, r); });
  lex.forEach((id, r) => { score.set(id, (score.get(id) ?? 0) + wl / (RRF_K + r + 1)); lr.set(id, r); });
  const order = [...score.keys()];
  const idx = new Map(order.map((id, i) => [id, i]));
  const sorted = order.sort((a, b) => {
    const d = score.get(b)! - score.get(a)!;
    if (d !== 0) return d;
    if (v === "V1") {
      const x = (lr.get(a) ?? Infinity) - (lr.get(b) ?? Infinity);
      if (x !== 0) return x;
    }
    return idx.get(a)! - idx.get(b)!;
  });
  const rest = dense.filter((id) => !score.has(id));
  return [...sorted, ...rest];
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage : tsx bench/hybrid-variants.ts <dossier-profil-copie> [--port 8920]");
  const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 8920);
  const app = new JarodApp({ plugins: { storage: { dataDir: dir, cipher: electronSecretsCipher(electronUserDataDir(process.env)) }, llm: {}, embeddings: { modelDir: EMB_MODEL, port, isolation: {} }, rag: { embeddingsDefaultUrl: `http://127.0.0.1:${port}/v1` } } } as never);
  const started = await start(app);
  const a = app as unknown as { storage: { db: { all<T>(sql: string, ...p: unknown[]): T[] } }; embeddings: { host: { ready(): Promise<void> } | null; embed(t: string[]): Promise<Float32Array[]> } };
  try {
    await a.embeddings.host?.ready();
    const rows = a.storage.db.all<Row>("SELECT id, doc_id, ord, text, dim, embedding, source FROM rag_chunks ORDER BY id");
    const vecs = rows.map((r) => floats(r.embedding));
    const embed = async (texts: string[]) => {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 16) out.push(...(await a.embeddings.embed(texts.slice(i, i + 16))));
      return out;
    };
    const capped = (ids: string[]) => {
      const per = new Map<string, number>();
      const out: string[] = [];
      for (const id of ids) {
        const doc = id.slice(0, id.lastIndexOf("#"));
        const n = per.get(doc) ?? 0;
        if (n >= PER_DOC) continue;
        per.set(doc, n + 1);
        out.push(id);
      }
      return out;
    };
    const ranking = (q: string, qv: Float32Array, v: Variant | "dense"): string[] => {
      const dense = rows.map((r, i) => ({ id: k(r), s: cos(qv, vecs[i]!) })).sort((x, y) => y.s - x.s).map((x) => x.id);
      if (v === "dense") return capped(dense);
      const fq = ftsQuery(q, "or");
      const lex = fq ? a.storage.db.all<{ doc_id: string; ord: number }>("SELECT c.doc_id, c.ord FROM rag_chunks_fts f JOIN rag_chunks c ON c.id = f.rowid WHERE rag_chunks_fts MATCH ? ORDER BY bm25(rag_chunks_fts), c.id LIMIT ?", fq, DEPTH).map(k) : [];
      return capped(lex.length ? fuse(dense, lex, v) : dense);
    };
    const variants: (Variant | "dense")[] = ["dense", "V0", "V1", "V2"];
    const stats = (ranks: (number | null)[]) => ({
      "@1": ranks.filter((r) => r !== null && r <= 1).length,
      "@3": ranks.filter((r) => r !== null && r <= 3).length,
      "@10": ranks.filter((r) => r !== null && r <= 10).length,
      mrr: Number((ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length).toFixed(4)),
    });
    const rankIn = (list: string[], ok: Set<string>) => { const p = list.findIndex((id) => ok.has(id)); return p >= 0 ? p + 1 : null; };

    // B' (200 extraits) et A' passage (22 questions), comme hybrid-gate.ts
    const norm1 = (s: string) => s.replace(/\s+/g, " ");
    const bq: { text: string; ok: Set<string> }[] = [];
    for (const r of rows.filter((r) => r.text.length >= 400)) {
      if (bq.length >= 200) break;
      const ext = norm1(r.text).slice(100, 300).trim();
      if (ext.length < 100) continue;
      bq.push({ text: ext, ok: new Set(rows.filter((x) => norm1(x.text).includes(ext)).map(k)) });
    }
    const spec = JSON.parse(readFileSync(join(HERE, "a-prime-targets.json"), "utf8")) as { docs: Record<string, string>; questions: { n: number; answer: string[] }[] };
    const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const questions = lines.filter((l) => !HEADERS.some((h) => h.test(l)));
    const full = (s: string) => { const [d, o] = s.split("#"); return `${spec.docs[d!]}#${o}`; };
    const aq = spec.questions.map((t, i) => ({ t, q: questions[i]! })).filter((x) => x.t.answer.length).map((x) => ({ text: x.q, ok: new Set(x.t.answer.map(full)) }));

    for (const [label, qs] of [["(c) B' extraits", bq], ["(b) A' passage", aq]] as const) {
      const qv = await embed(qs.map((x) => x.text));
      console.log(`${label} — ${qs.length} requêtes`);
      for (const v of variants) {
        const s = stats(qs.map((x, i) => rankIn(ranking(x.text, qv[i]!, v), x.ok)));
        console.log(`   ${v.padEnd(5)} @1 ${s["@1"]}  @3 ${s["@3"]}  @10 ${s["@10"]}  MRR ${s.mrr}`);
      }
    }
    // (a) test 3, même règle que la gate
    const srcRows = rows.map((r) => ({ source: r.source ?? r.doc_id, text: r.text }));
    console.log("(a) test 3 — rang du document attendu (dense | V0 | V1 | V2)");
    for (const want of ["MATRICE_ESCALADE", "Formation_Presentation_GSMR"]) {
      const per = new Map<string, Map<string, number>>();
      for (const r of srcRows) { const m = per.get(r.source) ?? new Map<string, number>(); for (const t of new Set(fold(r.text).match(/[a-z]{8,}/g) ?? [])) m.set(t, (m.get(t) ?? 0) + 1); per.set(r.source, m); }
      const mine = [...per.entries()].find(([s]) => s.includes(want))![1];
      const others = new Set<string>(); for (const [s, m] of per) if (!s.includes(want)) for (const t of m.keys()) others.add(t);
      const terms = [...mine.entries()].filter(([t, n]) => n === 1 && !others.has(t)).map(([t]) => t).sort((x, y) => y.length - x.length || x.localeCompare(y)).slice(0, 3);
      const qv = await embed(terms);
      terms.forEach((t, i) => {
        const cells = variants.map((v) => { const l = ranking(t, qv[i]!, v).slice(0, 10); const p = l.findIndex((id) => rows.find((r) => k(r) === id && (r.source ?? r.doc_id).includes(want))); return p >= 0 ? p + 1 : "absent"; });
        console.log(`   ${want} « ${t} » : ${cells.join(" | ")}`);
      });
    }
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
