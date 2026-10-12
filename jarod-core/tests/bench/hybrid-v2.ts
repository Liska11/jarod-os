/**
 * Évaluateur HORS SERVICE de la recherche hybride V2 (SPECS-P5-HYBRID-V2.md ; constantes et barres FIGÉES le 2026-10-02 avant toute mesure).
 * Reproduit la chaîne de `RagService.search` (classement dense exact, plafond par document) pour la comparer à V1, V2a et V2b sur une COPIE du
 * profil réel. Deux commandes :
 *
 *   tsx bench/hybrid-v2.ts controls <copie>   CONTRÔLE DE FIDÉLITÉ (autorisé à tout moment) : dense et V1 doivent retrouver EXACTEMENT les chiffres
 *                                            de la gate (B' 167/188/188 et 174/190/190 ; A' 16/19/20 et 17/20/21 ; jeu n° 1 12/14/14 et 10/13/13).
 *                                            Écart = l'évaluateur est faux : arrêt, aucune mesure de V2.
 *   tsx bench/hybrid-v2.ts measure <copie>    UNE SEULE mesure de V2a et V2b, toutes barres. Refuse : si le jeu n° 2 n'est pas validé, si les contrôles
 *                                            ne passent pas, si une mesure a déjà été faite (`--again` la refait et le dit au rapport).
 *
 * L'état est vérifié au départ de chaque barre (`bench-state.ts`, leçon du 2026-10-02). V2b utilise le VRAI worker du reranker (NPU, ≈ 90 s).
 * Ne rend que des compteurs, des rangs et des termes choisis par la règle de test 3.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir, ftsQuery } from "@jarod/plugin-storage";
import { resetBenchState } from "./bench-state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EMB_MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const RR_MODEL = join(ROOT, "tools", "ov-bge-reranker-int8-b8x512");
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];
const MEASURE_FILE = join(ROOT, ".work", "hybrid-v2-measure.json");

// ── constantes FIGÉES (SPECS-P5-HYBRID-V2.md §2) ────────────────────────────────────────────────────────────────────────────────────────────
const DEPTH = 50;
const RRF_K = 60;
const PER_DOC = 2;
const IDF_MIN = 3.0;
const POOL = 16;
const POOL_DENSE = 12;
const POOL_LEX = POOL - POOL_DENSE; // M = 4
const DEADLINE_MS = 30_000; // le banc juge l'ORDRE du reranker, pas son échéance de service

interface Row { id: number; doc_id: string; ord: number; text: string; dim: number; embedding: Buffer; source: string | null }
type Variant = "dense" | "V1" | "V2a";
type Q = { text: string; ok: Set<string> };
type Db = { all<T>(sql: string, ...p: unknown[]): T[]; get<T>(sql: string, ...p: unknown[]): T | undefined };
type Rr = { available: boolean; rerank(r: { query: string; candidates: { id: number; text: string }[]; topN: number; deadlineMs: number }): Promise<{ id: number; score: number }[]> };

const key = (r: { doc_id: string; ord: number }) => `${r.doc_id}#${r.ord}`;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[‘’]/g, "'").toLowerCase();
const floats = (b: Buffer) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const cos = (a: Float32Array, b: Float32Array): number => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};
const rankIn = (list: string[], ok: ReadonlySet<string>): number | null => { const p = list.findIndex((id) => ok.has(id)); return p >= 0 ? p + 1 : null; };
const stats = (ranks: (number | null)[]) => ({
  at1: ranks.filter((r) => r !== null && r <= 1).length,
  at3: ranks.filter((r) => r !== null && r <= 3).length,
  at10: ranks.filter((r) => r !== null && r <= 10).length,
  mrr: Number((ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / (ranks.length || 1)).toFixed(4)),
});
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [mode, dir] = argv;
  if ((mode !== "controls" && mode !== "measure") || !dir) throw new Error("usage : tsx bench/hybrid-v2.ts <controls|measure> <dossier-profil-copie> [--port 8920] [--again]");
  const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8920);

  // ── jeux de données ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const a1 = JSON.parse(readFileSync(join(HERE, "a-prime-targets.json"), "utf8")) as { docs: Record<string, string>; questions: { n: number; answer: string[] }[] };
  const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const aQuestions = lines.filter((l) => !HEADERS.some((h) => h.test(l)));
  const fullA = (s: string) => `${a1.docs[s.split("#")[0]!]}#${s.split("#")[1]}`;
  const setA: Q[] = a1.questions.map((t, i) => ({ t, q: aQuestions[i]! })).filter((x) => x.t.answer.length).map((x) => ({ text: x.q, ok: new Set(x.t.answer.map(fullA)) }));
  const loadHeld = (file: string, needValidated: boolean) => {
    const raw = readFileSync(join(HERE, file), "utf8");
    const h = JSON.parse(raw) as { validated: boolean; docs: Record<string, string>; questions: { n: number; q: string; answer: string[] }[] };
    if (needValidated && !h.validated) throw new Error(`${file} : cibles NON validées par l'utilisateur ("validated": false) — aucune mesure de V2 dessus.`);
    const full = (s: string) => `${h.docs[s.split("#")[0]!]}#${s.split("#")[1]}`;
    return { set: h.questions.map((x) => ({ text: x.q, ok: new Set(x.answer.map(full)) })) as Q[], sha: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
  };
  const held1 = loadHeld("hybrid-heldout.json", true);
  const held2 = mode === "measure" ? loadHeld("hybrid-heldout-2.json", true) : null;

  if (mode === "measure" && existsSync(MEASURE_FILE) && !argv.includes("--again")) throw new Error(`une mesure existe déjà (${MEASURE_FILE}) : la mesure de V2 est UNIQUE (SPECS-P5-HYBRID-V2.md §3) ; --again la refait et le consigne.`);

  // ── chaîne ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const cipher = electronSecretsCipher(electronUserDataDir(process.env));
  if (mode === "measure") {
    const first = new JarodApp({ plugins: { storage: { dataDir: dir, cipher } } } as never);
    const st = await start(first);
    const s = (first as unknown as { storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } } }).storage.settings;
    s.set("rag", { ...s.get("rag"), enabled: true });
    s.set("ecosystem", { ...s.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: POOL, rerankDeadlineMs: 4000, rerankMode: "shadow" });
    await stop(st);
  }
  const app = new JarodApp({
    plugins: {
      storage: { dataDir: dir, cipher },
      llm: {},
      embeddings: { modelDir: EMB_MODEL, port, isolation: {}, ...(mode === "measure" ? { reranker: { modelDir: RR_MODEL, port: 8930, batch: 8, maxLength: 512 } } : {}) },
      rag: { embeddingsDefaultUrl: `http://127.0.0.1:${port}/v1` },
    },
  } as never);
  const started = await start(app);
  const a = app as unknown as { storage: { db: Db }; embeddings: { host: { ready(): Promise<void> } | null; embed(t: string[]): Promise<Float32Array[]> }; reranker?: Rr };
  const db = a.storage.db;
  try {
    await a.embeddings.host?.ready();
    const rows = db.all<Row>("SELECT id, doc_id, ord, text, dim, embedding, source FROM rag_chunks ORDER BY id");
    const N = rows.length;
    const vecs = rows.map((r) => floats(r.embedding));
    const byKey = new Map(rows.map((r, i) => [key(r), i]));
    const qvCache = new Map<string, Float32Array>();
    const embed = async (texts: string[]) => {
      const need = [...new Set(texts)].filter((t) => !qvCache.has(t));
      for (let i = 0; i < need.length; i += 16) {
        const part = need.slice(i, i + 16);
        const v = await a.embeddings.embed(part);
        part.forEach((t, j) => qvCache.set(t, v[j]!));
      }
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
    const denseFull = (q: string): string[] => {
      const qv = qvCache.get(q)!;
      return rows.map((r, i) => ({ id: key(r), s: cos(qv, vecs[i]!) })).sort((x, y) => y.s - x.s).map((x) => x.id);
    };
    const lexical = (match: string): string[] =>
      db.all<{ doc_id: string; ord: number }>("SELECT c.doc_id, c.ord FROM rag_chunks_fts f JOIN rag_chunks c ON c.id = f.rowid WHERE rag_chunks_fts MATCH ? ORDER BY bm25(rag_chunks_fts), c.id LIMIT ?", match, DEPTH).map(key);
    /** Porte de rareté : termes de ftsQuery dont idf BM25 ≥ IDF_MIN ; chaîne MATCH des termes gardés, ou null. */
    const rareQuery = (q: string): string | null => {
      const terms = q.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0).slice(0, 16).map((t) => t.replace(/"/g, ""));
      const kept: string[] = [];
      for (const t of terms) {
        const df = db.get<{ n: number }>("SELECT count(*) AS n FROM rag_chunks_fts WHERE rag_chunks_fts MATCH ?", `"${t}"*`)?.n ?? 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        if (df >= 1 && idf >= IDF_MIN) kept.push(`"${t}"*`);
      }
      return kept.length ? kept.join(" OR ") : null;
    };
    /** Fusion RRF, égalité → meilleur rang lexical (règle V1, reprise telle quelle par V2a). */
    const fuse = (dense: string[], lex: string[]): string[] => {
      const score = new Map<string, number>();
      const lr = new Map<string, number>();
      dense.slice(0, DEPTH).forEach((id, r) => score.set(id, 1 / (RRF_K + r + 1)));
      lex.forEach((id, r) => { score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + r + 1)); lr.set(id, r); });
      const order = [...score.keys()];
      const sorted = order.sort((x, y) => score.get(y)! - score.get(x)! || (lr.get(x) ?? Infinity) - (lr.get(y) ?? Infinity));
      return [...sorted, ...dense.filter((id) => !score.has(id))];
    };
    const ranking = (q: string, v: Variant): string[] => {
      const dense = denseFull(q);
      if (v === "dense") return capped(dense);
      const m = v === "V1" ? ftsQuery(q, "or") : rareQuery(q);
      const lex = m ? lexical(m) : [];
      return capped(lex.length ? fuse(dense, lex) : dense);
    };
    /** V2b : lot de 16 = 12 premiers denses (plafonnés) + jusqu'à 4 « lexical seulement » (termes rares, plafonnés), complété par le dense suivant. */
    const pools = (q: string): { base: string[]; v2b: string[]; dense: string[] } => {
      const dense = capped(denseFull(q));
      const base = dense.slice(0, POOL);
      const head = dense.slice(0, POOL_DENSE);
      const m = rareQuery(q);
      const per = new Map<string, number>();
      for (const id of head) per.set(id.slice(0, id.lastIndexOf("#")), (per.get(id.slice(0, id.lastIndexOf("#"))) ?? 0) + 1);
      const extras: string[] = [];
      if (m) {
        for (const id of lexical(m)) {
          if (extras.length >= POOL_LEX) break;
          const doc = id.slice(0, id.lastIndexOf("#"));
          if (head.includes(id) || extras.includes(id) || (per.get(doc) ?? 0) >= PER_DOC) continue;
          per.set(doc, (per.get(doc) ?? 0) + 1);
          extras.push(id);
        }
      }
      const fill = dense.slice(POOL_DENSE).filter((id) => !extras.includes(id)).slice(0, POOL_LEX - extras.length);
      return { base, v2b: [...head, ...extras, ...fill], dense };
    };
    const rerankList = async (q: string, pool: string[], dense: string[]): Promise<string[]> => {
      const cands = pool.map((id, i) => ({ id: i, text: rows[byKey.get(id)!]!.text }));
      const hits = await a.reranker!.rerank({ query: q, candidates: cands, topN: cands.length, deadlineMs: DEADLINE_MS });
      const order = hits.map((h) => pool[h.id]!);
      const inPool = new Set(pool);
      return [...order, ...dense.filter((id) => !inPool.has(id))];
    };

    // ── état de départ de chaque barre ─────────────────────────────────────────────────────────────────────────────────────────────────────
    const norm1 = (s: string) => s.replace(/\s+/g, " ");
    const bq: Q[] = [];
    for (const r of rows.filter((r) => r.text.length >= 400)) {
      if (bq.length >= 200) break;
      const ext = norm1(r.text).slice(100, 300).trim();
      if (ext.length < 100) continue;
      bq.push({ text: ext, ok: new Set(rows.filter((x) => norm1(x.text).includes(ext)).map(key)) });
    }
    const allQ = [...bq, ...setA, ...held1.set, ...(held2?.set ?? [])];
    await embed(allQ.map((x) => x.text));
    const state = (label: string) =>
      resetBenchState(label, {
        rag: { setEmbedder: () => {}, search: async (q) => capped(denseFull(q)).slice(0, 1).map((id) => ({ docId: id.slice(0, id.lastIndexOf("#")), ord: Number(id.slice(id.lastIndexOf("#") + 1)) })) },
        setFlag: () => {},
        canary: { text: bq[0]!.text, ok: bq[0]!.ok },
      });

    const run = (set: Q[], v: Variant) => stats(set.map((x) => rankIn(ranking(x.text, v), x.ok)));
    const show = (label: string, s: ReturnType<typeof stats>) => `${label.padEnd(6)} @1 ${s.at1}  @3 ${s.at3}  @10 ${s.at10}  MRR ${s.mrr}`;

    // ── CONTRÔLES DE FIDÉLITÉ (dense et V1 = chiffres de la gate) ─────────────────────────────────────────────────────────────────────────
    await state("contrôles");
    const EXPECT: Record<string, [Variant, Q[], [number, number, number]]> = {
      "B' dense": ["dense", bq, [167, 188, 188]],
      "B' V1": ["V1", bq, [174, 190, 190]],
      "A' dense": ["dense", setA, [16, 19, 20]],
      "A' V1": ["V1", setA, [17, 20, 21]],
      "jeu1 dense": ["dense", held1.set, [12, 14, 14]],
      "jeu1 V1": ["V1", held1.set, [10, 13, 13]],
    };
    let faithful = true;
    for (const [label, [v, set, want]] of Object.entries(EXPECT)) {
      const s = run(set, v);
      const ok = s.at1 === want[0] && s.at3 === want[1] && s.at10 === want[2];
      faithful &&= ok;
      console.log(`contrôle ${label.padEnd(11)} : ${s.at1}/${s.at3}/${s.at10} (attendu ${want.join("/")}) ${ok ? "OK" : "ÉCART"}`);
    }
    if (!faithful) throw new Error("ÉVALUATEUR INFIDÈLE : les contrôles ne retrouvent pas les chiffres de la gate — aucune mesure de V2.");
    console.log("CONTRÔLES DE FIDÉLITÉ : tous retrouvés.");
    if (mode === "controls") return;

    // ── MESURE UNIQUE ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const report: Record<string, unknown> = { at: new Date().toISOString(), again: argv.includes("--again"), jeu2Sha: held2!.sha, jeu1Sha: held1.sha, constants: { IDF_MIN, DEPTH, RRF_K, PER_DOC, POOL, POOL_DENSE, POOL_LEX } };
    const verdict = { V2a: {} as Record<string, boolean | null>, V2b: {} as Record<string, boolean | null> };
    const ge = (x: ReturnType<typeof stats>, ref: ReturnType<typeof stats>) => x.at1 >= ref.at1 && x.at3 >= ref.at3 && x.at10 >= ref.at10;
    const lost = (set: Q[], refRanks: (number | null)[], newRanks: (number | null)[]) => set.map((_, i) => i + 1).filter((n) => refRanks[n - 1] !== null && refRanks[n - 1]! <= 10 && (newRanks[n - 1] === null || newRanks[n - 1]! > 10));

    // V2a contre le dense (sans reranker)
    for (const [bar, label, set] of [["B", "A' passage", setA], ["D", "jeu n° 1", held1.set], ["E", "jeu n° 2 (NEUF)", held2!.set]] as const) {
      await state(`barre (${bar}) V2a`);
      const dr = set.map((x) => rankIn(ranking(x.text, "dense"), x.ok));
      const vr = set.map((x) => rankIn(ranking(x.text, "V2a"), x.ok));
      const ds = stats(dr), vs = stats(vr), lo = lost(set, dr, vr);
      verdict.V2a[bar] = ge(vs, ds) && (bar === "B" || lo.length === 0);
      report[`V2a_${bar}`] = { dense: ds, v2a: vs, perte: lo, ranks: set.map((_, i) => [dr[i], vr[i]]) };
      console.log(`V2a (${bar}) ${label} ${set.length} q — ${show("dense", ds)} | ${show("V2a", vs)} | sorties du top 10 : ${lo.length ? lo.join(",") : "aucune"} → ${verdict.V2a[bar] ? "TENUE" : "MANQUÉE"}`);
    }
    await state("barre (C) V2a");
    {
      const ds = run(bq, "dense"), vs = run(bq, "V2a");
      verdict.V2a.C = vs.at3 >= ds.at3;
      report.V2a_C = { dense: ds, v2a: vs };
      console.log(`V2a (C) B' ${bq.length} extraits — ${show("dense", ds)} | ${show("V2a", vs)} → ${verdict.V2a.C ? "TENUE" : "MANQUÉE"}`);
    }

    // test 3 (A) : règle de diag-search, inchangée
    await state("barre (A)");
    const per = new Map<string, Map<string, number>>();
    for (const r of rows) { const src = r.source ?? r.doc_id; const m = per.get(src) ?? new Map<string, number>(); for (const t of new Set(fold(r.text).match(/[a-z]{8,}/g) ?? [])) m.set(t, (m.get(t) ?? 0) + 1); per.set(src, m); }
    const t3: { want: string; term: string }[] = [];
    for (const want of ["MATRICE_ESCALADE", "Formation_Presentation_GSMR"]) {
      const mine = [...per.entries()].find(([s]) => s.includes(want))![1];
      const others = new Set<string>(); for (const [s, m] of per) if (!s.includes(want)) for (const t of m.keys()) others.add(t);
      for (const term of [...mine.entries()].filter(([t, n]) => n === 1 && !others.has(t)).map(([t]) => t).sort((x, y) => y.length - x.length || x.localeCompare(y)).slice(0, 3)) t3.push({ want, term });
    }
    await embed(t3.map((x) => x.term));
    const docRank = (list: string[], want: string) => { const p = list.slice(0, 10).findIndex((id) => (rows[byKey.get(id)!]!.source ?? rows[byKey.get(id)!]!.doc_id).includes(want)); return p >= 0 ? p + 1 : null; };
    const t3a = t3.map((x) => ({ ...x, dense: docRank(ranking(x.term, "dense"), x.want), v2a: docRank(ranking(x.term, "V2a"), x.want) }));
    const crit = (want: string) => t3a.find((x) => x.want === want)!;
    verdict.V2a.A = crit("MATRICE_ESCALADE").v2a === 1 && crit("Formation_Presentation_GSMR").v2a === 1;
    report.test3_V2a = t3a;
    console.log(`V2a (A) test 3 — rangs (dense | V2a) : ${t3a.map((x) => `${x.term} ${x.dense ?? "-"}|${x.v2a ?? "-"}`).join("  ")} ; informatif en tête ${t3a.filter((x) => x.v2a === 1).length}/6 → ${verdict.V2a.A ? "TENUE" : "MANQUÉE"}`);

    // coût du côté lexical de V2a (hors service : indicatif, la barre (F) se mesure dans le service)
    await state("barre (F) indicatif");
    const lat: number[] = [];
    for (const x of [...setA, ...held1.set]) { const t0 = performance.now(); rareQuery(x.text); const m = rareQuery(x.text); if (m) lexical(m); lat.push((performance.now() - t0) / 2); }
    report.latenceLexicaleIndicative = { p50: Number(pct(lat, 50).toFixed(2)), p95: Number(pct(lat, 95).toFixed(2)), n: lat.length };
    console.log(`V2a (F) indicatif — comptes df + FTS5 : p50 ${pct(lat, 50).toFixed(2)} ms, p95 ${pct(lat, 95).toFixed(2)} ms (la barre (F) du service reste à mesurer à l'implémentation)`);

    // V2b contre « dense, lot de 16 + reranker »
    const tr0 = Date.now();
    while (a.reranker && !a.reranker.available && Date.now() - tr0 < 360_000) await new Promise((r) => setTimeout(r, 500));
    if (!a.reranker?.available) throw new Error("le reranker n'est pas devenu disponible en 360 s : V2b non mesurable");
    for (const [bar, label, set] of [["B", "A' passage", setA], ["D", "jeu n° 1", held1.set], ["E", "jeu n° 2 (NEUF)", held2!.set]] as const) {
      await state(`barre (${bar}) V2b`);
      const baseR: (number | null)[] = [], v2bR: (number | null)[] = [];
      for (const x of set) {
        const p = pools(x.text);
        baseR.push(rankIn(await rerankList(x.text, p.base, p.dense), x.ok));
        v2bR.push(rankIn(await rerankList(x.text, p.v2b, p.dense), x.ok));
      }
      const bs = stats(baseR), vs = stats(v2bR), lo = lost(set, baseR, v2bR);
      verdict.V2b[bar] = ge(vs, bs) && (bar === "B" || lo.length === 0);
      report[`V2b_${bar}`] = { base: bs, v2b: vs, perte: lo, ranks: set.map((_, i) => [baseR[i], v2bR[i]]) };
      console.log(`V2b (${bar}) ${label} ${set.length} q — ${show("lot16+rr", bs)} | ${show("V2b", vs)} | sorties du top 10 : ${lo.length ? lo.join(",") : "aucune"} → ${verdict.V2b[bar] ? "TENUE" : "MANQUÉE"}`);
    }
    await state("barre (A) V2b");
    const t3b: { term: string; want: string; base: number | null; v2b: number | null }[] = [];
    for (const x of t3) {
      const p = pools(x.term);
      t3b.push({ ...x, base: docRank(await rerankList(x.term, p.base, p.dense), x.want), v2b: docRank(await rerankList(x.term, p.v2b, p.dense), x.want) });
    }
    const crit2 = (want: string) => t3b.find((x) => x.want === want)!;
    verdict.V2b.A = (crit2("MATRICE_ESCALADE").v2b ?? 99) <= 3 && (crit2("Formation_Presentation_GSMR").v2b ?? 99) <= 3;
    report.test3_V2b = t3b;
    console.log(`V2b (A) test 3 — rangs (lot16+rr | V2b) : ${t3b.map((x) => `${x.term} ${x.base ?? "-"}|${x.v2b ?? "-"}`).join("  ")} → critère ≤ 3 : ${verdict.V2b.A ? "TENUE" : "MANQUÉE"}`);

    report.verdict = verdict;
    const tout = (v: Record<string, boolean | null>) => Object.values(v).every((x) => x === true);
    console.log(`\nVERDICT (hors barres (F) latence du service et (G) régressions, mesurées à l'implémentation) : V2a ${tout(verdict.V2a) ? "TENUE" : "MANQUÉE"} (${JSON.stringify(verdict.V2a)}) ; V2b ${tout(verdict.V2b) ? "TENUE" : "MANQUÉE"} (${JSON.stringify(verdict.V2b)})`);
    mkdirSync(join(ROOT, ".work"), { recursive: true });
    writeFileSync(MEASURE_FILE, JSON.stringify(report, null, 1));
    console.log(`jeu n° 2 SHA-256 ${held2!.sha} ; rapport : ${MEASURE_FILE}`);
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
