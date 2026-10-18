/**
 * Bench Q16 multilingue (checkpoint `convaiinnovations/laya-multilingual`, accord B19), barre FIGÉE le 2026-09-29
 * (`q16-ml-verdict.ts`, DECISIONS) AVANT tout run. Chaque mesure tourne dans un PROCESSUS NEUF (`worker`) :
 *   - 0. contrôle : le tokenizer dérivé (noms des jetons spéciaux seulement) encode EXACTEMENT comme l'original ;
 *   - 1. CPU, graphe exporté + tokenizer dérivé : 3 processus (latence, RSS, décisions de référence = celles du verdict) ;
 *   - 2. identification de l'adaptateur DirectML (compteurs GPU du processus + registre DirectX), AVANT toute latence DirectML ;
 *   - 3. DirectML, graphe dérivé `allowzero=0` : 3 processus (parité et latence, sans seuil).
 * Les fichiers reçus (`tools/laya-multilingual-onnx/`) ne sont jamais modifiés : les dérivés vivent sous `.work/q16/`
 * (poids en lien physique). Le baseline bge-m3 zéro-exemple vient de `.work/q16/bge.json` (`bench:q16-embed`, à lancer avant).
 * Rapport horodaté `.work/q16/report-ml-<date>.json`. Jamais deux benchmarks à la fois : machine calme, ce script seul.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type BgeVectors, BGE_FILE } from "./q16-embed.js";
import { type LayaDevice, LayaDecisionEngine } from "./q16-engine.js";
import { effectOf, FIXTURES, INTENT_DESCRIPTIONS, INTENTS, type Intent, QUESTIONS } from "./q16-fixtures.js";
import { patchAllowZero, renameSpecials, SPECIAL_IDS } from "./q16-ml-bundle.js";
import { type Q16MlMeasures, q16MlVerdict } from "./q16-ml-verdict.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "tools", "laya-multilingual-onnx");
const Q16_DIR = join(ROOT, ".work", "q16");
const CPU_DIR = join(Q16_DIR, "laya-ml-cpu");
const DML_DIR = join(Q16_DIR, "laya-ml-dml");
const REVISION = "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67";
/** sha256 des sorties d'export, relevés à la fin de l'export (`.work/b19-out-sha.txt`, DECISIONS « B19 — reçu, exporté »). */
const OUT_SHA: Record<string, string> = {
  "laya.onnx": "d73c614632f9099f3056c698b58bf3dfd87ab2390fafb173620fc2337518597e",
  "laya.onnx.data": "6ef993ee707fe1d6a75529f4a1f8347ff89966ff955d332ea3ebe4e5171a9ac1",
  "laya_config.json": "ce46a634bb6b9c93975219a7ea646e16c6e00cf99ff2d985d25f8337aa1ef31c",
  "tokenizer/tokenizer.json": "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
  "tokenizer/tokenizer_config.json": "424b69444bf7b5809dc2cd2e36d0bd71b8055124dd24274d6db3c655d38205e7",
};
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
}

const mb = (b: number) => Math.round((b / 2 ** 20) * 10) / 10;
/** Quantile « rang le plus proche » (médiane basse pour p = 0,5), arrondi à 0,01 ms — pour les latences seulement. */
const q = (xs: readonly number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! * 100) / 100;
};
const median = (xs: readonly number[]) => q(xs, 0.5);
/** Médiane basse SANS arrondi : la confiance est comparée à la barre telle quelle. */
const lowMedian = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length / 2) - 1]!;

function sha256(file: string): Promise<string> {
  return new Promise((ok, ko) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", ko);
  });
}

async function verifyReceived(): Promise<void> {
  for (const [f, want] of Object.entries(OUT_SHA)) {
    const p = join(MODEL, f);
    if (!existsSync(p)) throw new Error(`modèle absent : ${p}`);
    if ((await sha256(p)) !== want) throw new Error(`${f} ne correspond pas au sha256 relevé à l'export`);
  }
}

/** Texte de chaque requête que Laya encode : instructions, options rendues, états FR/EN (le contrôle porte sur tout ça). */
function controlTexts(): string[] {
  const out: string[] = [];
  for (const q of QUESTIONS) {
    out.push(`${q.type} question: ${q.instructions}`);
    if (q.type === "choice") for (const o of q.options) out.push(` ${o}: ${INTENT_DESCRIPTIONS[o as Intent]}`, ` ${o}`);
  }
  out.push(" false: no, the statement does not hold", " true: yes, the statement holds");
  for (const f of FIXTURES) out.push(f.fr, f.en);
  return out;
}

interface Tok {
  encode(t: string, o: { add_special_tokens: boolean }): { ids: number[] };
  token_to_id(t: string): number | undefined;
}

async function loadTokenizerClass(): Promise<new (json: unknown, cfg: unknown) => Tok> {
  const layaEntry = createRequire(import.meta.url).resolve("@receptron/laya");
  const tokEntry = createRequire(layaEntry).resolve("@huggingface/tokenizers");
  return ((await import(pathToFileURL(tokEntry).href)) as { Tokenizer: new (json: unknown, cfg: unknown) => Tok }).Tokenizer;
}

/** Bundles dérivés : tokenizer aux noms Laya (CPU et DML), graphe `allowzero=0` (DML) ; poids en lien physique. */
async function ensureDerived(): Promise<{ renamed: number; patched: number; control: { texts: number; identical: boolean } }> {
  const rd = (f: string) => readFileSync(join(MODEL, f));
  const tok = renameSpecials(JSON.parse(rd("tokenizer/tokenizer.json").toString("utf8")));
  const cfg = renameSpecials(JSON.parse(rd("tokenizer/tokenizer_config.json").toString("utf8")));
  const graph = patchAllowZero(rd("laya.onnx"));
  for (const dir of [CPU_DIR, DML_DIR]) {
    mkdirSync(join(dir, "tokenizer"), { recursive: true });
    writeFileSync(join(dir, "laya_config.json"), rd("laya_config.json"));
    writeFileSync(join(dir, "tokenizer", "tokenizer.json"), JSON.stringify(tok.json));
    writeFileSync(join(dir, "tokenizer", "tokenizer_config.json"), JSON.stringify(cfg.json));
    if (!existsSync(join(dir, "laya.onnx.data"))) linkSync(join(MODEL, "laya.onnx.data"), join(dir, "laya.onnx.data"));
  }
  writeFileSync(join(CPU_DIR, "laya.onnx"), rd("laya.onnx"));
  writeFileSync(join(DML_DIR, "laya.onnx"), graph.model);

  // Contrôle : mêmes ids pour les jetons spéciaux, mêmes séquences sur tous les textes de la requête.
  const Tokenizer = await loadTokenizerClass();
  const rj = (f: string) => JSON.parse(rd(f).toString("utf8")) as unknown;
  const orig = new Tokenizer(rj("tokenizer/tokenizer.json"), rj("tokenizer/tokenizer_config.json"));
  const derived = new Tokenizer(tok.json, cfg.json);
  const ids = Object.entries(SPECIAL_IDS).every(([name, id]) => derived.token_to_id(name) === id);
  const texts = controlTexts();
  const same = texts.every((t) => JSON.stringify(orig.encode(t, { add_special_tokens: false }).ids) === JSON.stringify(derived.encode(t, { add_special_tokens: false }).ids));
  return { renamed: tok.renamed + cfg.renamed, patched: graph.patched, control: { texts: texts.length, identical: ids && same } };
}

async function worker(device: LayaDevice, modelDir: string, out: string, hold: boolean): Promise<void> {
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const engine = await LayaDecisionEngine.load({ modelDir, device, descriptions: { intent: INTENT_DESCRIPTIONS }, version: REVISION.slice(0, 8) });
  const loadMs = performance.now() - t0;
  const decide = (state: string) => engine.decide({ state, questions: QUESTIONS, deadlineMs: 60_000 });
  try {
    for (let w = 0; w < WARMUP; w++) await decide(FIXTURES[w]!.en);
    if (hold) {
      // Identification de l'adaptateur : la session reste chargée, le parent lit les compteurs GPU de ce processus.
      console.log(`READY ${process.pid}`);
      await new Promise<void>((r) => process.stdin.on("end", r).resume());
      return;
    }
    const results: StateResult[] = [];
    for (const lang of ["fr", "en"] as const)
      for (const [i, f] of FIXTURES.entries()) {
        const r = await decide(f[lang]);
        const [intent, effect] = r.answers;
        if (intent?.type !== "choice" || effect?.type !== "noul" || r.timedOut) throw new Error(`réponse inattendue (${lang} ${i})`);
        results.push({ lang, i, choice: intent.value, probs: intent.probabilities, effect: effect.probability, ms: r.ms });
      }
    const report: WorkerReport = {
      device,
      modelDir,
      loadMs: Math.round(loadMs),
      rssBeforeMb: mb(rssBefore),
      rssAfterMb: mb(process.memoryUsage().rss),
      maxLen: engine.limits.maxLen,
      results,
    };
    writeFileSync(out, JSON.stringify(report));
  } finally {
    await engine.close();
  }
}

function runWorker(device: LayaDevice, modelDir: string, tag: string): WorkerReport {
  const out = join(Q16_DIR, `worker-ml-${tag}.json`);
  console.log(`[q16-ml] ${tag} (${device}, ${modelDir === CPU_DIR ? "graphe exporté" : "graphe dérivé"})…`);
  execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "worker", device, modelDir, out], { stdio: ["ignore", "inherit", "pipe"], cwd: ROOT });
  return JSON.parse(readFileSync(out, "utf8")) as WorkerReport;
}

/** PowerShell (encodé : aucun échappement) : mémoire GPU du processus par adaptateur (LUID) + description DirectX de chaque LUID. */
const ADAPTER_PS = `
param([int]$ProcId)
$mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $_.Name -like ('pid_' + $ProcId + '_*') }
$adapters = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\DirectX' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.AdapterLuid } | ForEach-Object {
  [pscustomobject]@{ luid = ('luid_0x{0:X8}_0x{1:X8}' -f ([int64]$_.AdapterLuid -shr 32), ([int64]$_.AdapterLuid -band 0xFFFFFFFF)); description = $_.Description; dedicatedMb = [math]::Round($_.DedicatedVideoMemory / 1MB) }
}
[pscustomobject]@{ process = @($mem | ForEach-Object { [pscustomobject]@{ name = $_.Name; dedicatedMb = [math]::Round($_.DedicatedUsage / 1MB, 1); sharedMb = [math]::Round($_.SharedUsage / 1MB, 1) } }); adapters = @($adapters) } | ConvertTo-Json -Depth 4 -Compress
`;

interface AdapterInfo {
  used: { luid: string; description: string | null; dedicatedMb: number; sharedMb: number }[];
  adapters: { luid: string; description: string; dedicatedMb: number }[];
  error: string | null;
}

async function identifyAdapter(): Promise<AdapterInfo> {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "worker", "dml", DML_DIR, "-", "hold"], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
  const pid = await new Promise<number>((ok, ko) => {
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /READY (\d+)/.exec(buf);
      if (m) ok(Number(m[1]));
    });
    child.on("exit", (c) => ko(new Error(`worker d'identification arrêté (code ${c})`)));
  });
  try {
    const script = ADAPTER_PS.replace("param([int]$ProcId)", `$ProcId = ${pid}`);
    const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" });
    const j = JSON.parse(raw) as { process: { name: string; dedicatedMb: number; sharedMb: number }[]; adapters: AdapterInfo["adapters"] };
    const used = j.process
      .map((p) => {
        const luid = /luid_0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+/.exec(p.name)?.[0] ?? p.name;
        return { luid, description: j.adapters.find((a) => a.luid.toLowerCase() === luid.toLowerCase())?.description ?? null, dedicatedMb: p.dedicatedMb, sharedMb: p.sharedMb };
      })
      .filter((u) => u.dedicatedMb > 0 || u.sharedMb > 0);
    return { used, adapters: j.adapters, error: used.length ? null : "aucune mémoire GPU attribuée au processus" };
  } catch (e) {
    return { used: [], adapters: [], error: String((e as Error).message).slice(0, 300) };
  } finally {
    child.stdin.end();
    await new Promise((r) => child.on("exit", r));
  }
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

/** 1 − H(p)/ln(k) : même définition que le prototype anglais. */
const confidence = (probs: readonly number[]) => 1 - -probs.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0) / Math.log(probs.length);

/** `dry` : vérifie la réception (sha256), écrit les bundles dérivés et rend le contrôle d'encodage — AUCUN modèle chargé, aucune mesure. */
async function dry(): Promise<void> {
  mkdirSync(Q16_DIR, { recursive: true });
  await verifyReceived();
  console.log(JSON.stringify(await ensureDerived()));
}

async function main(): Promise<void> {
  if (process.env.Q16_ML_CALM !== "1") throw new Error("Q16_ML_CALM=1 requis : machine calme, aucun autre benchmark en cours (règle : jamais deux mesures à la fois)");
  mkdirSync(Q16_DIR, { recursive: true });
  await verifyReceived();
  const derived = await ensureDerived();
  console.log(`[q16-ml] dérivés : ${derived.renamed} noms renommés, ${derived.patched} Reshape allowzero 1→0 ; contrôle d'encodage (${derived.control.texts} textes) : ${derived.control.identical ? "identique" : "DIFFÉRENT"}`);
  if (!derived.control.identical) throw new Error("le tokenizer dérivé n'encode pas comme l'original : arrêt avant toute mesure");

  const cpu = Array.from({ length: REPEATS }, (_, r) => runWorker("cpu", CPU_DIR, `cpu-${r}`));
  const adapter = await identifyAdapter();
  console.log(`[q16-ml] adaptateur DirectML : ${JSON.stringify(adapter.used)}${adapter.error ? ` (${adapter.error})` : ""}`);
  const dml: WorkerReport[] = [];
  let dmlError: string | null = null;
  try {
    for (let r = 0; r < REPEATS; r++) dml.push(runWorker("dml", DML_DIR, `dml-${r}`));
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
  const reminderFr = fr.filter((r) => FIXTURES[r.i]!.intent === "reminder");
  const measures: Q16MlMeasures = {
    frIntent: bgeFr ? { laya: hits(fr), bge: bgeHits(bgeFr), total: fr.length } : null,
    frMedianConfidence: lowMedian(fr.map((r) => confidence(r.probs))),
    frReminder: { hits: reminderFr.filter((r) => r.choice === "reminder").length, total: reminderFr.length },
  };
  const verdict = q16MlVerdict(measures);
  const confusion = (rs: readonly StateResult[]) =>
    Object.fromEntries(INTENTS.map((i) => [i, Object.fromEntries(INTENTS.map((j) => [j, rs.filter((r) => FIXTURES[r.i]!.intent === i && r.choice === j).length]))]));
  const report = {
    at: new Date().toISOString(),
    model: { repo: "convaiinnovations/laya-multilingual", revision: REVISION, runtime: "onnxruntime-node (celui du dépôt)", laya: "@receptron/laya 0.1.2" },
    derived,
    measures,
    verdict,
    noThreshold: {
      adapter,
      latencyCpu: latency(cpu),
      latencyDml: dml.length ? latency(dml) : null,
      dmlError,
      cpuRepeatStability: cpu.slice(1).map((w) => compare(ref, w)),
      dmlVsCpu: dml.map((w) => compare(ref, w)),
      enIntent: { laya: hits(en), bge: bgeEn ? bgeHits(bgeEn) : null, total: en.length },
      frEffect: { laya: effectHits(fr), majority: FIXTURES.filter((f) => !effectOf(f.intent)).length, total: fr.length },
      frEnAgreement: fr.filter((r, k) => r.choice === en[k]!.choice).length,
      medianConfidenceEn: lowMedian(en.map((r) => confidence(r.probs))),
      confusionFr: confusion(fr),
      confusionEn: confusion(en),
      bgeDevice: bge?.device ?? null,
      maxLen: ref.maxLen,
    },
  };
  const file = join(Q16_DIR, `report-ml-${report.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ measures, verdict, adapter: adapter.used, latencyCpu: report.noThreshold.latencyCpu, latencyDml: report.noThreshold.latencyDml, en: report.noThreshold.enIntent, frEn: report.noThreshold.frEnAgreement }, null, 2));
  console.log(`[q16-ml] rapport → ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, device, modelDir, out, hold] = process.argv.slice(2);
  (mode === "worker" ? worker(device as LayaDevice, modelDir!, out!, hold === "hold") : mode === "dry" ? dry() : main()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
