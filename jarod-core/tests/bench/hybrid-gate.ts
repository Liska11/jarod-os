/**
 * Gate de la recherche hybride (SPECS-P5-HYBRID.md §3 ; barres FIGÉES dans DECISIONS 2026-10-01 « rag.hybrid : spec VALIDÉE… », commit 6d5fcc4,
 * AVANT toute mesure de l'hybride). Chaîne réelle : kernel, worker d'embeddings, `RagService.search` (plafond par document compris), sur une COPIE
 * de la base du profil réel (la migration FTS5 s'y applique). Le drapeau `ecosystem.hybrid` bascule éteint / allumé sur la MÊME copie.
 *
 *     tsx bench/hybrid-gate.ts <dossier-profil-copie> [--port 8920]
 *
 * (a) test 3 : règle de choix des termes de `packages/cli/src/diag-search.ts` (inchangée) ; (b) jeu A' passage (22 questions) @1/@3/@10 ;
 * (c) garde-fou C0-b B' (extraits) @3 ; (d) latence ajoutée (écarts appariés par requête, médiane de 5 répétitions, vecteurs de requête déjà
 * calculés pour n'isoler que FTS5 + fusion) ; chaque barre et chaque chiffre sont imprimés, rien n'est ajusté. Ne rend que des compteurs, des rangs
 * et des termes exclusifs choisis par la règle (aucun texte de passage).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";
import { resetBenchState } from "./bench-state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const EMB_MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];
const LIMIT = 50;
const ELIGIBLE = 400;
const MAX_QUERIES = 200;
const LAT_REPS = 5;
const LAT_BAR_MS = 25;

interface Hit {
  docId: string;
  ord: number;
  text: string;
  score: number;
  source?: string | null;
}
type Rag = { search(q: string, k?: number): Promise<Hit[]>; setEmbedder(f: ((t: string[]) => Promise<Float32Array[]>) | null): void };
type Settings = { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void };

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const key = (h: { docId: string; ord: number }) => `${h.docId}#${h.ord}`;
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const median = (xs: number[]) => pct(xs, 50);
const rankOf = (list: string[], ok: Set<string>): number | null => {
  const p = list.findIndex((id) => ok.has(id));
  return p >= 0 ? p + 1 : null;
};
const recall = (ranks: (number | null)[]) => ({
  at1: ranks.filter((r) => r !== null && r <= 1).length,
  at3: ranks.filter((r) => r !== null && r <= 3).length,
  at10: ranks.filter((r) => r !== null && r <= 10).length,
  mrr: Number((ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length).toFixed(4)),
});

/** Règle de `diag-search.ts`, COPIÉE sans changement : mot de lettres seules (≥ 8), dans UN seul passage du document et dans AUCUN autre, le plus long. */
function exclusiveTerms(rows: { source: string; text: string }[], want: string): string[] {
  const perDoc = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const terms = new Set(fold(r.text).match(/[a-z]{8,}/g) ?? []);
    const m = perDoc.get(r.source) ?? new Map<string, number>();
    for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
    perDoc.set(r.source, m);
  }
  const mine = [...perDoc.entries()].filter(([s]) => s.includes(want));
  if (mine.length !== 1) throw new Error(`« ${want} » correspond à ${mine.length} source(s)`);
  const [, terms] = mine[0]!;
  const others = new Set<string>();
  for (const [s, m] of perDoc) if (!s.includes(want)) for (const t of m.keys()) others.add(t);
  return [...terms.entries()].filter(([t, n]) => n === 1 && !others.has(t)).map(([t]) => t).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dir = argv[0];
  if (!dir) throw new Error("usage : tsx bench/hybrid-gate.ts <dossier-profil-copie> [--port 8920]");
  const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 8920);
  const cipher = electronSecretsCipher(electronUserDataDir(process.env));
  const app = new JarodApp({
    plugins: {
      storage: { dataDir: dir, cipher },
      llm: {},
      embeddings: { modelDir: EMB_MODEL, port, isolation: {} },
      rag: { embeddingsDefaultUrl: `http://127.0.0.1:${port}/v1` },
    },
  } as never);
  const started = await start(app);
  const a = app as unknown as {
    rag: { rag: Rag };
    storage: { db: { all<T>(sql: string): T[]; get<T>(sql: string): T | undefined }; settings: Settings };
    embeddings: { host: { ready(): Promise<void> } | null; embed(t: string[]): Promise<Float32Array[]> };
  };
  const real = a.rag.rag;
  const flag = (hybrid: "on" | "off") => a.storage.settings.set("ecosystem", { ...a.storage.settings.get("ecosystem"), hybrid });
  try {
    await a.embeddings.host?.ready();
    const rows = a.storage.db.all<{ id: number; doc_id: string; ord: number; text: string; source: string | null }>("SELECT id, doc_id, ord, text, source FROM rag_chunks ORDER BY id");
    const ftsRows = a.storage.db.get<{ n: number }>("SELECT count(*) AS n FROM rag_chunks_fts");
    console.log(`copie du profil : ${rows.length} passages, index FTS5 : ${ftsRows?.n ?? "absent"} ligne(s), ${new Set(rows.map((r) => r.doc_id)).size} documents`);
    const report: Record<string, unknown> = { at: new Date().toISOString(), passages: rows.length };

    // ── (c) garde-fou C0-b B' : extraits verbatim [100 ; 300) des passages de ≥ 400 caractères ─────────────────────────────────────────────
    const norm1 = (s: string) => s.replace(/\s+/g, " ");
    const bq: { text: string; ok: Set<string> }[] = [];
    for (const r of rows.filter((r) => r.text.length >= ELIGIBLE)) {
      if (bq.length >= MAX_QUERIES) break;
      const ext = norm1(r.text).slice(100, 300).trim();
      if (ext.length < 100) continue;
      bq.push({ text: ext, ok: new Set(rows.filter((x) => norm1(x.text).includes(ext)).map((x) => `${x.doc_id}#${x.ord}`)) });
    }
    // LEÇON du 2026-10-02 : l'état du banc est vérifié (et remis à zéro) au départ de CHAQUE barre ; le canari est un extrait dont la réponse est connue.
    if (!bq.length) throw new Error("aucun extrait pour le canari de l'état du banc");
    const canary = { text: bq[0]!.text, ok: bq[0]!.ok };
    const state = (label: string) => resetBenchState(label, { rag: real, setFlag: flag, canary });
    const runSet = async (queries: { text: string; ok: Set<string> }[]) => {
      const out: Record<"off" | "on", (number | null)[]> = { off: [], on: [] };
      for (const mode of ["off", "on"] as const) {
        flag(mode);
        for (const q of queries) out[mode].push(rankOf((await real.search(q.text, LIMIT)).map(key), q.ok));
      }
      return { dense: recall(out.off), hybrid: recall(out.on), ranks: out };
    };
    await state("barre (c)");
    const c = await runSet(bq);
    report.c = { n: bq.length, dense: c.dense, hybrid: c.hybrid };
    const barC = c.hybrid.at3 >= c.dense.at3;
    console.log(`(c) B' ${bq.length} extraits — dense @1 ${c.dense.at1} @3 ${c.dense.at3} @10 ${c.dense.at10} ; hybride @1 ${c.hybrid.at1} @3 ${c.hybrid.at3} @10 ${c.hybrid.at10} → BARRE (c) @3 hybride ≥ dense : ${barC ? "TENUE" : "MANQUÉE"}`);

    // ── (b) jeu A' passage : 22 questions notées ───────────────────────────────────────────────────────────────────────────────────────────────
    const spec = JSON.parse(readFileSync(join(HERE, "a-prime-targets.json"), "utf8")) as { docs: Record<string, string>; questions: { n: number; answer: string[] }[] };
    const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const questions = lines.filter((l) => !HEADERS.some((h) => h.test(l)));
    if (questions.length !== spec.questions.length) throw new Error(`${questions.length} questions pour ${spec.questions.length} cibles`);
    const full = (s: string) => {
      const [k, o] = s.split("#");
      return `${spec.docs[k!]}#${o}`;
    };
    const scoredQ = spec.questions.map((t, i) => ({ t, q: questions[i]! })).filter((x) => x.t.answer.length > 0);
    const aq = scoredQ.map((x) => ({ text: x.q, ok: new Set(x.t.answer.map(full)) }));
    await state("barre (b)");
    const b = await runSet(aq);
    report.b = { n: aq.length, dense: b.dense, hybrid: b.hybrid, ranks: Object.fromEntries(scoredQ.map((x, i) => [x.t.n, [b.ranks.off[i], b.ranks.on[i]]])) };
    const barB = b.hybrid.at1 >= b.dense.at1 && b.hybrid.at3 >= b.dense.at3 && b.hybrid.at10 >= b.dense.at10;
    console.log(`(b) A' passage ${aq.length} questions — dense @1 ${b.dense.at1} @3 ${b.dense.at3} @10 ${b.dense.at10} MRR ${b.dense.mrr} ; hybride @1 ${b.hybrid.at1} @3 ${b.hybrid.at3} @10 ${b.hybrid.at10} MRR ${b.hybrid.mrr} → BARRE (b) ≥ dense à chaque rang : ${barB ? "TENUE" : "MANQUÉE"}`);
    console.log("    rang du 1er passage-réponse (dense | hybride) : " + scoredQ.map((x, i) => `Q${x.t.n} ${b.ranks.off[i] ?? "-"}|${b.ranks.on[i] ?? "-"}`).join("  "));

    // ── (a) test 3 : termes exclusifs, règle de diag-search inchangée ──────────────────────────────────────────────────────────────────────────
    await state("barre (a)");
    const srcRows = rows.map((r) => ({ source: r.source ?? r.doc_id, text: r.text }));
    const a3: Record<string, { term: string; dense: number | null; hybrid: number | null }[]> = {};
    let criterion = true;
    let infoTop = 0;
    for (const want of ["MATRICE_ESCALADE", "Formation_Presentation_GSMR"]) {
      const terms = exclusiveTerms(srcRows, want).slice(0, 3);
      a3[want] = [];
      for (const [i, term] of terms.entries()) {
        const ranks: Record<"off" | "on", number | null> = { off: null, on: null };
        for (const mode of ["off", "on"] as const) {
          flag(mode);
          const hits = await real.search(term, 10);
          const p = hits.findIndex((h) => (h.source ?? h.docId).includes(want));
          ranks[mode] = p >= 0 ? p + 1 : null;
        }
        a3[want]!.push({ term, dense: ranks.off, hybrid: ranks.on });
        if (ranks.on === 1) infoTop++;
        if (i === 0 && ranks.on !== 1) criterion = false;
        console.log(`(a) ${want} « ${term} » ${i === 0 ? "CRITÈRE" : "info   "} — rang dense ${ranks.off ?? "absent"} ; rang hybride ${ranks.on ?? "absent"}`);
      }
    }
    const barA = criterion;
    report.a = { terms: a3, informatifEnTete: infoTop };
    console.log(`(a) termes en tête en hybride : ${infoTop}/6 (dense : ${Object.values(a3).flat().filter((x) => x.dense === 1).length}/6) → BARRE (a) les 2 termes du CRITÈRE en tête : ${barA ? "TENUE" : "MANQUÉE"} ; informatif ≥ 5/6 : ${infoTop >= 5 ? "oui" : "non"}`);

    // ── (f) HORS ÉCHANTILLON : questions nouvelles, cibles validées par l'utilisateur AVANT toute mesure (SPECS-P5-HYBRID.md §3.1) ────────────
    const held = JSON.parse(readFileSync(join(HERE, "hybrid-heldout.json"), "utf8")) as { validated: boolean; docs: Record<string, string>; questions: { n: number; q: string; answer: string[] }[] };
    await state("barre (f)");
    let barF: boolean | null = null;
    if (!held.validated) {
      console.log("(f) hors échantillon : NON MESURÉE — les cibles de tests/bench/hybrid-heldout.json ne sont pas validées par l'utilisateur (\"validated\": false).");
    } else {
      const fullH = (s: string) => {
        const [d, o] = s.split("#");
        return `${held.docs[d!]}#${o}`;
      };
      const hq = held.questions.map((x) => ({ text: x.q, ok: new Set(x.answer.map(fullH)) }));
      const f = await runSet(hq);
      const lost = held.questions.filter((x, i) => f.ranks.off[i] !== null && f.ranks.off[i]! <= 10 && (f.ranks.on[i] === null || f.ranks.on[i]! > 10)).map((x) => x.n);
      barF = f.hybrid.at1 >= f.dense.at1 && f.hybrid.at3 >= f.dense.at3 && f.hybrid.at10 >= f.dense.at10 && lost.length === 0;
      report.f = { n: hq.length, dense: f.dense, hybrid: f.hybrid, ranks: Object.fromEntries(held.questions.map((x, i) => [x.n, [f.ranks.off[i], f.ranks.on[i]]])), lost };
      console.log(`(f) hors échantillon ${hq.length} questions — dense @1 ${f.dense.at1} @3 ${f.dense.at3} @10 ${f.dense.at10} MRR ${f.dense.mrr} ; hybride @1 ${f.hybrid.at1} @3 ${f.hybrid.at3} @10 ${f.hybrid.at10} MRR ${f.hybrid.mrr} ; sorties du top 10 : ${lost.length ? lost.join(",") : "aucune"} → BARRE (f) : ${barF ? "TENUE" : "MANQUÉE"}`);
      console.log("    rang du passage-réponse (dense | hybride) : " + held.questions.map((x, i) => `Q${x.n} ${f.ranks.off[i] ?? "-"}|${f.ranks.on[i] ?? "-"}`).join("  "));
    }

    // (f) est mesurée AVANT (d) : (d) installe un calculateur d'embeddings figé (setEmbedder) qui fausserait toute requête suivante.
    // ── (d) latence ajoutée par FTS5 + fusion : vecteurs de requête figés, écarts appariés ────────────────────────────────────────────────────
    await state("barre (d)");
    const lq = [...aq.map((x) => x.text), ...bq.slice(0, 40).map((x) => x.text)];
    const vecs = new Map<string, Float32Array>();
    for (let i = 0; i < lq.length; i += 16) {
      const batch = lq.slice(i, i + 16);
      const v = await a.embeddings.embed(batch);
      batch.forEach((t, j) => { vecs.set(t, v[j]!); });
    }
    let current = "";
    real.setEmbedder(async () => [vecs.get(current)!]);
    const deltas: number[] = [];
    const t = async (mode: "on" | "off", q: string) => {
      flag(mode);
      current = q;
      const s = performance.now();
      await real.search(q, LIMIT);
      return performance.now() - s;
    };
    for (const q of lq) await t("off", q); // chauffe
    for (const q of lq) {
      const off: number[] = [];
      const on: number[] = [];
      for (let r = 0; r < LAT_REPS; r++) {
        off.push(await t("off", q));
        on.push(await t("on", q));
      }
      deltas.push(median(on) - median(off));
    }
    const lat = { n: deltas.length, p50: Number(median(deltas).toFixed(2)), p95: Number(pct(deltas, 95).toFixed(2)), max: Number(Math.max(...deltas).toFixed(2)) };
    const barD = lat.p95 <= LAT_BAR_MS;
    report.d = lat;
    console.log(`(d) latence ajoutée (écarts appariés, ${lat.n} requêtes × ${LAT_REPS} répétitions) : p50 ${lat.p50} ms, p95 ${lat.p95} ms, max ${lat.max} ms → BARRE (d) p95 ≤ ${LAT_BAR_MS} ms : ${barD ? "TENUE" : "MANQUÉE"}`);

    report.bars = { a: barA, b: barB, c: barC, d: barD, f: barF };
    mkdirSync(join(ROOT, ".work"), { recursive: true });
    const file = join(ROOT, ".work", `hybrid-gate-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 1));
    console.log(`\nBARRES : (a) ${barA ? "TENUE" : "MANQUÉE"}  (b) ${barB ? "TENUE" : "MANQUÉE"}  (c) ${barC ? "TENUE" : "MANQUÉE"}  (d) ${barD ? "TENUE" : "MANQUÉE"}  (f) ${barF === null ? "NON MESURÉE" : barF ? "TENUE" : "MANQUÉE"}  — (e) par les suites.\nrapport : ${file}`);
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
