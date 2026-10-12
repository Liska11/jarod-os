/**
 * Bench Q16 (prototype Laya, checkpoint anglais `receptron/laya-onnx`), critère figé le 2026-09-29
 * (`q16-verdict.ts`, DECISIONS). Chaque mesure tourne dans un PROCESSUS NEUF (`worker`) :
 *   - CPU, graphe publié : 3 processus (latence, RSS, décisions de référence) ;
 *   - CPU, graphe dérivé `allowzero=0` : 1 processus (le graphe dérivé ne change rien sur CPU) ;
 *   - DirectML, graphe dérivé : 3 processus (parité et latence).
 * L'alternative simple (bge-m3 NPU zéro-exemple) vient de `.work/q16/bge.json` (`bench:q16-embed`,
 * à lancer avant). Rapport horodaté `.work/q16/report-<date>.json`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BgeVectors, BGE_FILE } from "./q16-embed.js";
import { type LayaDevice, LayaDecisionEngine } from "./q16-engine.js";
import { effectOf, FIXTURES, INTENT_DESCRIPTIONS, INTENTS, type Intent, longStates, QUESTIONS } from "./q16-fixtures.js";
import { type Q16Measures, q16Verdict } from "./q16-verdict.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "tools", "laya-onnx");
const Q16_DIR = join(ROOT, ".work", "q16");
const PATCHED = join(Q16_DIR, "laya-dml");
const REVISION = "68f27dfe5a27a54fb2b1fefc432f43f972e90868";
/** sha256 LFS publié de `laya.onnx` (licenses/B18.md). */
const ONNX_SHA = "a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e";
const REPEATS = 3;
const WARMUP = 3;

interface StateResult {
  lang: "fr" | "en";
  i: number;
  choice: string | null;
  probs: number[];
  effect: number;
  ms: number;
}

interface WorkerReport {
  device: LayaDevice;
  modelDir: string;
  loadMs: number;
  rssBeforeMb: number;
  rssAfterMb: number;
  maxLen: number;
  results: StateResult[];
  long: { where: "before" | "after"; choice: string | null; tokensByQuestion: number[]; ok: boolean; error?: string }[];
}

const mb = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;
const q = (xs: readonly number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! * 100) / 100;
};
const median = (xs: readonly number[]) => q(xs, 0.5);

/** Graphe dérivé pour DirectML (DECISIONS 2026-09-29) : `allowzero` 1 → 0 sur les Reshape, poids en lien physique. */
function ensurePatched(): void {
  const src = readFileSync(join(MODEL, "laya.onnx"));
  if (createHash("sha256").update(src).digest("hex") !== ONNX_SHA) throw new Error("laya.onnx ne correspond pas au sha256 publié");
  mkdirSync(join(PATCHED, "tokenizer"), { recursive: true });
  const b = Buffer.from(src);
  let k = -1;
  let n = 0;
  while ((k = b.indexOf("allowzero", k + 1)) >= 0) {
    // AttributeProto : nom « allowzero » puis champ 3 (varint `i`) = 0x18, valeur.
    if (b[k + 9] === 0x18 && b[k + 10] === 1) {
      b[k + 10] = 0;
      n++;
    }
  }
  if (n !== 77) throw new Error(`graphe dérivé : ${n} Reshape allowzero=1 au lieu de 77`);
  writeFileSync(join(PATCHED, "laya.onnx"), b);
  for (const f of ["laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"]) writeFileSync(join(PATCHED, f), readFileSync(join(MODEL, f)));
  if (!existsSync(join(PATCHED, "laya.onnx.data"))) linkSync(join(MODEL, "laya.onnx.data"), join(PATCHED, "laya.onnx.data"));
}

async function worker(device: LayaDevice, modelDir: string, out: string): Promise<void> {
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const engine = await LayaDecisionEngine.load({ modelDir, device, descriptions: { intent: INTENT_DESCRIPTIONS }, version: REVISION.slice(0, 8) });
  const loadMs = performance.now() - t0;
  const decide = (state: string, questions = QUESTIONS) => engine.decide({ state, questions, deadlineMs: 60_000 });
  try {
    for (let w = 0; w < WARMUP; w++) await decide(FIXTURES[w]!.en);
    const results: StateResult[] = [];
    for (const lang of ["fr", "en"] as const)
      for (const [i, f] of FIXTURES.entries()) {
        const r = await decide(f[lang]);
        const [intent, effect] = r.answers;
        if (intent?.type !== "choice" || effect?.type !== "noul" || r.timedOut) throw new Error(`réponse inattendue (${lang} ${i})`);
        results.push({ lang, i, choice: intent.value, probs: intent.probabilities, effect: effect.probability, ms: r.ms });
      }
    const passage = readFileSync(join(ROOT, "PHASE-4.md"), "utf8").slice(0, 3200);
    const long: WorkerReport["long"] = [];
    const ls = longStates(passage);
    for (const where of ["before", "after"] as const) {
      try {
        const tokensByQuestion: number[] = [];
        for (const qq of QUESTIONS) {
          await decide(ls[where], [qq]);
          tokensByQuestion.push(engine.lastInputTokens);
        }
        const r = await decide(ls[where]);
        long.push({ where, choice: r.answers[0]?.type === "choice" ? r.answers[0].value : null, tokensByQuestion, ok: true });
      } catch (e) {
        long.push({ where, choice: null, tokensByQuestion: [], ok: false, error: String((e as Error).message).slice(0, 200) });
      }
    }
    const report: WorkerReport = {
      device,
      modelDir,
      loadMs: Math.round(loadMs),
      rssBeforeMb: mb(rssBefore),
      rssAfterMb: mb(process.memoryUsage().rss),
      maxLen: engine.limits.maxLen,
      results,
      long,
    };
    writeFileSync(out, JSON.stringify(report));
  } finally {
    await engine.close();
  }
}

function runWorker(device: LayaDevice, modelDir: string, tag: string): WorkerReport {
  const out = join(Q16_DIR, `worker-${tag}.json`);
  console.log(`[q16] ${tag} (${device}, ${modelDir === MODEL ? "graphe publié" : "graphe dérivé"})…`);
  execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "worker", device, modelDir, out], {
    stdio: ["ignore", "inherit", "pipe"],
    cwd: ROOT,
  });
  return JSON.parse(readFileSync(out, "utf8")) as WorkerReport;
}

const cosine = (a: readonly number[], b: readonly number[]) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return d / Math.sqrt(na * nb);
};

function bgeChoices(vs: readonly number[][], desc: Record<string, number[]>): Intent[] {
  return vs.map((v) => INTENTS.reduce((best, i) => (cosine(v, desc[i]!) > cosine(v, desc[best]!) ? i : best), INTENTS[0] as Intent));
}

function latency(ws: readonly WorkerReport[]) {
  const per = ws.map((w) => {
    const ms = w.results.map((r) => r.ms);
    return { p50: q(ms, 0.5), p95: q(ms, 0.95), loadMs: w.loadMs, rssDeltaMb: Math.round((w.rssAfterMb - w.rssBeforeMb) * 10) / 10 };
  });
  const agg = (k: keyof (typeof per)[number]) => ({ median: median(per.map((p) => p[k])), min: Math.min(...per.map((p) => p[k])), max: Math.max(...per.map((p) => p[k])) });
  return { p50Ms: agg("p50"), p95Ms: agg("p95"), loadMs: agg("loadMs"), rssDeltaMb: agg("rssDeltaMb") };
}

/** Écart max de probabilité et accord de décision entre deux runs sur les mêmes états. */
function compare(a: WorkerReport, b: WorkerReport) {
  let maxDiff = 0;
  let agree = 0;
  a.results.forEach((r, k) => {
    const s = b.results[k]!;
    for (let j = 0; j < r.probs.length; j++) maxDiff = Math.max(maxDiff, Math.abs(r.probs[j]! - s.probs[j]!));
    maxDiff = Math.max(maxDiff, Math.abs(r.effect - s.effect));
    if (r.choice === s.choice && r.effect >= 0.5 === s.effect >= 0.5) agree++;
  });
  return { agree, total: a.results.length, maxDiff: Math.round(maxDiff * 1e6) / 1e6 };
}

async function main(): Promise<void> {
  for (const f of ["laya.onnx", "laya.onnx.data"]) if (!existsSync(join(MODEL, f))) throw new Error(`modèle absent : ${join(MODEL, f)}`);
  mkdirSync(Q16_DIR, { recursive: true });
  ensurePatched();
  const cpu = Array.from({ length: REPEATS }, (_, r) => runWorker("cpu", MODEL, `cpu-${r}`));
  const patchedCpu = runWorker("cpu", PATCHED, "cpu-derive");
  const dml: WorkerReport[] = [];
  let dmlError: string | null = null;
  try {
    for (let r = 0; r < REPEATS; r++) dml.push(runWorker("dml", PATCHED, `dml-${r}`));
  } catch (e) {
    dmlError = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message).slice(-400);
  }

  const ref = cpu[0]!;
  const fr = ref.results.filter((r) => r.lang === "fr");
  const en = ref.results.filter((r) => r.lang === "en");
  const hits = (rs: readonly StateResult[]) => rs.filter((r) => r.choice === FIXTURES[r.i]!.intent).length;
  const effectHits = (rs: readonly StateResult[]) => rs.filter((r) => r.effect >= 0.5 === effectOf(FIXTURES[r.i]!.intent)).length;
  const bge = existsSync(BGE_FILE) ? (JSON.parse(readFileSync(BGE_FILE, "utf8")) as BgeVectors) : null;
  const bgeFr = bge ? bgeChoices(bge.fr, bge.desc) : null;
  const bgeEn = bge ? bgeChoices(bge.en, bge.desc) : null;
  const bgeHits = (cs: readonly Intent[]) => cs.filter((c, i) => c === FIXTURES[i]!.intent).length;
  const majority = FIXTURES.filter((f) => !effectOf(f.intent)).length;
  const cpuStable = cpu.slice(1).map((w) => compare(ref, w));
  const derive = compare(ref, patchedCpu);
  const dmlCmp = dml.length ? dml.map((w) => compare(ref, w)) : [];
  const longOk = ref.long.every((l) => l.ok);
  const maxTokens = Math.max(0, ...ref.long.flatMap((l) => l.tokensByQuestion));

  const measures: Q16Measures = {
    patchedCpuMaxDiff: derive.maxDiff,
    dml: dmlCmp.length === REPEATS ? { agree: Math.min(...dmlCmp.map((c) => c.agree)), total: ref.results.length, maxDiff: Math.max(...dmlCmp.map((c) => c.maxDiff)) } : null,
    frIntent: bgeFr ? { laya: hits(fr), bge: bgeHits(bgeFr), total: fr.length } : null,
    frEffect: { laya: effectHits(fr), majority, total: fr.length },
    longContext: { ok: longOk, maxTokens, maxLen: ref.maxLen },
  };
  const verdict = q16Verdict(measures);
  const confusion = (rs: readonly StateResult[]) =>
    Object.fromEntries(INTENTS.map((i) => [i, Object.fromEntries(INTENTS.map((j) => [j, rs.filter((r) => FIXTURES[r.i]!.intent === i && r.choice === j).length]))]));
  const conf = (rs: readonly StateResult[]) =>
    median(rs.map((r) => 1 - -r.probs.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0) / Math.log(r.probs.length)));
  const report = {
    at: new Date().toISOString(),
    model: { repo: "receptron/laya-onnx", revision: REVISION, runtime: "onnxruntime-node 1.30.0", laya: "@receptron/laya 0.1.2" },
    measures,
    verdict,
    noThreshold: {
      latencyCpu: latency(cpu),
      latencyDml: dml.length ? latency(dml) : null,
      dmlError,
      cpuRepeatStability: cpuStable,
      enIntent: { laya: hits(en), bge: bgeEn ? bgeHits(bgeEn) : null, total: en.length },
      enEffect: { laya: effectHits(en), majority, total: en.length },
      frEnAgreement: fr.filter((r, k) => r.choice === en[k]!.choice).length,
      medianConfidence: { fr: conf(fr), en: conf(en) },
      confusionFr: confusion(fr),
      confusionEn: confusion(en),
      bgeDevice: bge?.device ?? null,
      long: ref.long,
    },
  };
  const file = join(Q16_DIR, `report-${report.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ measures, verdict, latencyCpu: report.noThreshold.latencyCpu, latencyDml: report.noThreshold.latencyDml, en: report.noThreshold.enIntent, frEn: report.noThreshold.frEnAgreement, long: ref.long }, null, 2));
  console.log(`[q16] rapport → ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, device, modelDir, out] = process.argv.slice(2);
  (mode === "worker" ? worker(device as LayaDevice, modelDir!, out!) : main()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
