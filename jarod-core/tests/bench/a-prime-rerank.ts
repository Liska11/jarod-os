/**
 * Gate du reranker (SPECS-P5-RERANKER.md §8 ; barres FIGÉES dans DECISIONS 2026-10-01 « Reranker : spec validée… », commit 4333ac2), parties
 * (a) qualité, (b) latence, (c) parité d'appareil, relevés d'abstention et N = 8. La chaîne est la vraie : kernel, worker d'embeddings, worker du
 * reranker (IR figée 8×512), `RagService.search`. Les candidats sont ceux de la production (dense, plafond par document), jamais un classement
 * recalculé à part. Sur une COPIE de la base du profil. Ne rend que des compteurs, des identifiants `document#ordre` et des scores : aucun texte.
 *
 *     tsx bench/a-prime-rerank.ts <dossier-profil-copie> [--devices NPU,GPU.0,CPU] [--port 8930]      mesure et écrit .work/a-prime-rerank-<appareil>-<ts>.json
 *     tsx bench/a-prime-rerank.ts --compare <rapport A> <rapport B>                                 parité (c) : top-3 identique sur >= 22 des 25 questions
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { electronSecretsCipher, electronUserDataDir } from "@jarod/plugin-storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const HEADERS = [/^Réseau RMP/, /^Matrice d'escalade/, /^GTB & Supervision/, /^Procédures & Incidents/];
const EMB_MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const RR_MODEL = join(ROOT, "tools", "ov-bge-reranker-int8-b8x512");
const TOP_N = 16;
const DEADLINE_MS = 4000;
const LIMIT = 50;

interface Target {
  n: number;
  answer: string[];
  partial: string[];
}
interface Hit {
  docId: string;
  ord: number;
  text: string;
  score: number;
}
type Rag = { search(q: string, k?: number): Promise<Hit[]> };
type Svc = {
  available: boolean;
  info(): { device?: string };
  rerank(r: { query: string; candidates: { id: number; text: string }[]; topN: number; deadlineMs: number }): Promise<{ id: number; score: number }[]>;
};

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compare(fileA: string, fileB: string): void {
  const a = JSON.parse(readFileSync(fileA, "utf8")) as { device: string; top3: Record<string, string[]> };
  const b = JSON.parse(readFileSync(fileB, "utf8")) as { device: string; top3: Record<string, string[]> };
  const ns = Object.keys(a.top3);
  const same = ns.filter((n) => JSON.stringify(a.top3[n]) === JSON.stringify(b.top3[n]));
  const diff = ns.filter((n) => !same.includes(n));
  console.log(`parité top-3 ${a.device} contre ${b.device} : ${same.length}/${ns.length} questions identiques ; différentes : ${diff.join(", ") || "aucune"}`);
  console.log(`BARRE (c) >= 22/25 : ${same.length >= 22 ? "TENUE" : "MANQUÉE"}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--compare") return compare(argv[1]!, argv[2]!);
  const dir = argv[0];
  if (!dir) throw new Error("usage : tsx bench/a-prime-rerank.ts <dossier-profil-copie> [--devices NPU,GPU.0,CPU] [--port 8930]");
  const opt = (name: string): string | undefined => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const devices = (opt("--devices") ?? "NPU,GPU.0,CPU").split(",");
  const port = Number(opt("--port") ?? 8930);

  const spec = JSON.parse(readFileSync(join(HERE, "a-prime-targets.json"), "utf8")) as { docs: Record<string, string>; questions: Target[] };
  const lines = readFileSync(join(ROOT, "question test rag.txt"), "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const questions = lines.filter((l) => !HEADERS.some((h) => h.test(l)));
  if (questions.length !== spec.questions.length) throw new Error(`${questions.length} questions pour ${spec.questions.length} cibles`);
  const idOf = (h: { docId: string; ord: number }) => `${h.docId}#${h.ord}`;
  const full = (s: string) => {
    const [k, o] = s.split("#");
    return `${spec.docs[k!]}#${o}`;
  };

  const cipher = electronSecretsCipher(electronUserDataDir(process.env));
  // Phase 1 : les drapeaux se posent AVANT le démarrage du plugin (il les lit au démarrage), sur la copie seulement.
  {
    const first = new JarodApp({ plugins: { storage: { dataDir: dir, cipher } } } as never);
    const st = await start(first);
    const s = (first as unknown as { storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } } }).storage.settings;
    s.set("rag", { ...s.get("rag"), enabled: true });
    s.set("ecosystem", { ...s.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: TOP_N, rerankDeadlineMs: DEADLINE_MS, rerankMode: "active" });
    await stop(st);
  }
  const app = new JarodApp({
    plugins: {
      storage: { dataDir: dir, cipher },
      llm: {},
      embeddings: { modelDir: EMB_MODEL, port: 8920, isolation: {}, reranker: { modelDir: RR_MODEL, port, batch: 8, maxLength: 512, devices } },
      rag: { embeddingsDefaultUrl: "http://127.0.0.1:8920/v1" },
    },
  } as never);
  const started = await start(app);
  const a = app as unknown as { rag: { rag: Rag }; reranker: Svc; storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } } };
  try {
    const t0 = Date.now();
    while (!a.reranker.available && Date.now() - t0 < 360_000) await sleep(500);
    if (!a.reranker.available) throw new Error("le reranker n'est pas devenu disponible en 360 s");
    const coldStartMs = Date.now() - t0;
    const device = a.reranker.info().device ?? "?";
    console.log(`reranker prêt en ${coldStartMs} ms sur ${device}`);
    const flag = (patch: Record<string, unknown>) => a.storage.settings.set("ecosystem", { ...a.storage.settings.get("ecosystem"), ...patch });

    const per: Record<number, { base: string[]; r16: string[]; r8: string[]; e2e: string[]; top1Score: number | null; ms16: number; sameAsE2E: boolean }> = {};
    const latencies: number[] = [];
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi]!;
      const n = spec.questions[qi]!.n;
      flag({ reranker: "off" });
      const base = await a.rag.rag.search(q, LIMIT);
      const rr = async (count: number) => {
        const cands = base.slice(0, count);
        const t = Date.now();
        const hits = await a.reranker.rerank({ query: q, candidates: cands.map((h, i) => ({ id: i, text: h.text })), topN: cands.length, deadlineMs: DEADLINE_MS });
        const ms = Date.now() - t;
        const order = hits.map((h) => cands[h.id]!);
        const rest = base.slice(count);
        return { list: [...order, ...rest].map(idOf), ms, top: hits[0]?.score ?? null };
      };
      const r16 = await rr(TOP_N);
      latencies.push(r16.ms);
      const r8 = await rr(8);
      flag({ reranker: "bge-reranker-v2-m3-npu", rerankMode: "active" });
      const e2e = (await a.rag.rag.search(q, LIMIT)).map(idOf);
      per[n] = { base: base.map(idOf), r16: r16.list, r8: r8.list, e2e, top1Score: r16.top, ms16: r16.ms, sameAsE2E: JSON.stringify(e2e) === JSON.stringify(r16.list) };
    }

    const scored = spec.questions.filter((t) => t.answer.length > 0);
    const rankOf = (list: string[], answers: string[]): number | null => {
      const want = new Set(answers.map(full));
      const p = list.findIndex((id) => want.has(id));
      return p >= 0 ? p + 1 : null;
    };
    const stats = (key: "base" | "r16" | "r8") => {
      const ranks = scored.map((t) => rankOf(per[t.n]![key], t.answer));
      return {
        at1: ranks.filter((r) => r !== null && r <= 1).length,
        at3: ranks.filter((r) => r !== null && r <= 3).length,
        at10: ranks.filter((r) => r !== null && r <= 10).length,
        mrr: Number((ranks.reduce<number>((sum, r) => sum + (r ? 1 / r : 0), 0) / ranks.length).toFixed(4)),
        ranks: Object.fromEntries(scored.map((t, i) => [t.n, ranks[i]])),
      };
    };
    const base = stats("base");
    const r16s = stats("r16");
    const r8s = stats("r8");
    const e2eMatches = Object.values(per).filter((p) => p.sameAsE2E).length;
    const noAnswer = spec.questions.filter((t) => t.answer.length === 0).map((t) => t.n);
    const abst = {
      noAnswerTop: Object.fromEntries(noAnswer.map((n) => [n, per[n]!.top1Score])),
      answeredMin: Math.min(...scored.map((t) => per[t.n]!.top1Score ?? 0)),
      answeredMedian: [...scored.map((t) => per[t.n]!.top1Score ?? 0)].sort((x, y) => x - y)[scored.length >> 1]!,
    };
    const INDICATIVE_MRR_NOCAP = 0.8125;
    const barA = r16s.at1 >= 19 && r16s.at3 >= 19 && r16s.mrr >= Math.max(base.mrr, INDICATIVE_MRR_NOCAP);
    const lat = { p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(...latencies), n: latencies.length };
    const barB = lat.p95 <= DEADLINE_MS;
    const top3: Record<string, string[]> = Object.fromEntries(Object.entries(per).map(([n, p]) => [n, p.r16.slice(0, 3)]));
    const report = { at: new Date().toISOString(), device, devices, coldStartMs, topN: TOP_N, deadlineMs: DEADLINE_MS, baseline: base, reranked16: r16s, reranked8: r8s, latencies: lat, abstention: abst, e2eMatches, barA, barB, top3 };
    mkdirSync(join(ROOT, ".work"), { recursive: true });
    const file = join(ROOT, ".work", `a-prime-rerank-${device.replace(/\W/g, "_")}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    const f = (s: { at1: number; at3: number; at10: number; mrr: number }) => `@1 ${s.at1}/22  @3 ${s.at3}/22  @10 ${s.at10}/22  MRR ${s.mrr}`;
    console.log(`appareil ${device} ; démarrage à froid ${coldStartMs} ms`);
    console.log(`dense (production, plafond par document) ${f(base)}`);
    console.log(`reranké N=16 ${f(r16s)}`);
    console.log(`reranké N=8  ${f(r8s)}`);
    console.log("rang du 1er passage-réponse (dense | N=16 | N=8) :");
    for (const t of scored) console.log(`  Q${String(t.n).padStart(2)} ${String(base.ranks[t.n] ?? "-").padStart(3)} | ${String(r16s.ranks[t.n] ?? "-").padStart(3)} | ${String(r8s.ranks[t.n] ?? "-").padStart(3)}`);
    console.log(`latence d'un rerank de ${TOP_N} candidats : p50 ${lat.p50} ms, p95 ${lat.p95} ms, max ${lat.max} ms (n=${lat.n})`);
    console.log(`bout en bout (search actif) identique au rerank direct : ${e2eMatches}/${questions.length}`);
    console.log("abstention :", JSON.stringify(abst));
    console.log(`\nBARRE (a) @1 >= 19 ET @3 >= 19 ET MRR >= dense : ${barA ? "TENUE" : "MANQUÉE"}`);
    console.log(`BARRE (b) p95 <= ${DEADLINE_MS} ms : ${barB ? "TENUE" : "MANQUÉE"}\nrapport : ${file}`);
  } finally {
    await stop(started);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
