/**
 * Bench d'adoption Q15 (BESOINS Q15, PLAN §9.1) : turbovec contre l'index en mémoire actuel et contre une
 * quantification int8, sur les vecteurs bge-m3 RÉELS du corpus `bench:q15-corpus` (d = 1024), à 10³, 10⁴
 * et 10⁵ chunks. Rien n'est adopté ici : le bench mesure, le verdict est calculé et consigné, l'adoption
 * reste une décision (« aucun remplacement sans victoire mesurée »).
 *
 * Moteurs (chacun dans un processus NEUF par taille, pour une RAM mesurée sans résidu) :
 *   - memory      : `VectorIndex` de plugin-rag tel quel (float32, cosinus exact, tri complet) = référence
 *                   ET vérité terrain (recherche exacte) ;
 *   - int8        : quantification scalaire symétrique par vecteur (échelle max|x|/127), produit entier,
 *                   sélection des k meilleurs ;
 *   - turbovec-4 / turbovec-2 : sidecar `sidecars/turbovec` (accord B17), TQ+ calibré sur 1 024 lignes tirées
 *                   uniformément AVANT l'ingest, puis `addfile` par tranches de 10⁴, `prepare`, `write`.
 *
 * Chaque (moteur, taille) est mesuré REPS fois (3 par défaut) ; p95 et RAM = médiane, plage min–max relevée.
 * Mesures : p50/p95/max de la recherche seule (hors embedding de la requête : il est identique pour tous
 * les moteurs et déjà mesuré par `bench:eco`), sur 1 200 requêtes ; pour turbovec, temps dans le noyau
 * (`benchsearch`) ET de bout en bout par stdio (encodage base64 + échange compris : c'est le coût réel de
 * l'adaptateur). RAM : processus Node (rss après chargement et GC, moins rss avant) ; sidecar : working set
 * et pic Windows. Disque : octets des vecteurs (memory : blobs float32 de `rag_chunks`), fichier d'index
 * (turbovec). Rappel : @1/@3 à cible connue (24 documents P2 + 176 extraits) et rappel@10 contre la
 * recherche exacte (200 + 1 000 chunks tenus hors de l'index). Recherche filtrée (allowlist de 10³ ids).
 *
 *     pnpm --filter @jarod/gates bench:q15
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Query } from "./q15-corpus.js";
import { q15Verdict, type VerdictRun } from "./q15-verdict.js";

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), "../..");
const Q15 = join(ROOT, ".work", "q15");
const DIM = 1024;
const SIZES = [1_000, 10_000, 100_000];
const ENGINES = ["memory", "int8", "turbovec-4", "turbovec-2"] as const;
type Engine = (typeof ENGINES)[number];
const K = 10;
const SIDECAR = join(ROOT, "sidecars", "turbovec", "target", "release", process.platform === "win32" ? "turbovec-sidecar.exe" : "turbovec-sidecar");
const ALLOW = 1_000;
/** Répétitions par moteur et par taille (processus neufs) ; `Q15_REPS` pour un essai rapide. */
const REPS = Math.max(1, Number(process.env.Q15_REPS) || 3);

// ── Utilitaires ────────────────────────────────────────────────────────────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const mb = (b: number) => round(b / 2 ** 20);
function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)]!;
  return { n: s.length, p50Ms: round(p(50), 3), p95Ms: round(p(95), 3), maxMs: round(s.at(-1)!, 3) };
}

/** Nombre de requêtes : leurs vecteurs précèdent ceux des chunks dans `vectors.f32`. */
let QUERY_ROWS = 0;

/** Lit `rows` chunks à partir du chunk `from` (sans charger tout le fichier) ; `raw` : lignes absolues. */
function readRows(from: number, rows: number, raw = false): Float32Array {
  if (!raw) from += QUERY_ROWS;
  const buf = Buffer.alloc(rows * DIM * 4);
  const fd = openSync(join(Q15, "vectors.f32"), "r");
  try {
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, from * DIM * 4 + off);
      if (n <= 0) throw new Error("vectors.f32 trop court");
      off += n;
    }
  } finally {
    closeSync(fd);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, rows * DIM);
}

/** `chunks` : chunks DÉJÀ embarqués (le fichier peut être partiel : les tailles au-delà sont sautées). */
function corpusMeta(): { chunks: number; total: number; queries: Query[] } {
  const total = readFileSync(join(Q15, "chunks.jsonl"), "utf8").split("\n").filter(Boolean).length;
  const queries = JSON.parse(readFileSync(join(Q15, "queries.json"), "utf8")) as Query[];
  QUERY_ROWS = queries.length;
  const rows = Math.floor(statSync(join(Q15, "vectors.f32")).size / (DIM * 4));
  if (rows < queries.length) throw new Error("requêtes pas encore embarquées : lancez d'abord bench:q15-corpus");
  return { chunks: Math.min(total, rows - queries.length), total, queries };
}

function topK(scores: Float32Array | Float64Array, k: number): number[] {
  const ids: number[] = [];
  const best: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]!;
    if (best.length === k && s <= best[k - 1]!) continue;
    let j = best.length < k ? best.length : k - 1;
    while (j > 0 && best[j - 1]! < s) {
      if (j < k) {
        best[j] = best[j - 1]!;
        ids[j] = ids[j - 1]!;
      }
      j--;
    }
    best[j] = s;
    ids[j] = i;
  }
  return ids;
}

// ── Moteurs (processus enfant) ─────────────────────────────────────────────────────────────────

interface RunResult {
  engine: Engine;
  size: number;
  buildMs: number;
  ram: Record<string, number>;
  diskBytes: number;
  search: ReturnType<typeof stats>;
  kernel?: ReturnType<typeof stats>;
  allow?: ReturnType<typeof stats> & { allowSize: number; allInAllow: boolean };
  persist?: { firstSyncMs: number; incrSyncMs: number; fileBytes: number; reloadOk: boolean };
  top: number[][];
}

const gc = () => (globalThis as { gc?: () => void }).gc?.();
const rss = () => {
  gc();
  gc();
  return process.memoryUsage().rss;
};

async function runMemory(size: number, queries: Float32Array, nq: number): Promise<RunResult> {
  const { VectorIndex } = await import("@jarod/plugin-rag");
  const before = rss();
  const t0 = performance.now();
  let rows: { doc_id: string; ord: number; text: string; dim: number; embedding: Buffer; source: string | null }[] | null = [];
  {
    const v = readRows(0, size);
    for (let i = 0; i < size; i++) {
      rows.push({ doc_id: String(i), ord: 0, text: "", dim: DIM, source: null, embedding: Buffer.from(v.buffer, v.byteOffset + i * DIM * 4, DIM * 4) });
    }
  }
  const db = {
    get: () => ({ n: size, m: size }),
    all: () => {
      const r = rows!;
      rows = null; // Les blobs viennent de SQLite en vrai : ils ne restent pas en mémoire après chargement.
      return r;
    },
  };
  const index = new VectorIndex(db as never);
  index.stats();
  const buildMs = performance.now() - t0;
  const after = rss();
  const times: number[] = [];
  const top: number[][] = [];
  for (let q = 0; q < nq; q++) {
    const qv = queries.subarray(q * DIM, (q + 1) * DIM);
    const s = performance.now();
    const hits = index.ranked(qv).slice(0, K);
    times.push(performance.now() - s);
    top.push(hits.map((h) => Number(h.docId)));
  }
  return { engine: "memory", size, buildMs, ram: { dataMb: mb(size * DIM * 4), rssDeltaMb: mb(after - before), rssMb: mb(after), maxRssMb: round(process.resourceUsage().maxRSS / 1024) }, diskBytes: size * DIM * 4, search: stats(times), top };
}

async function runInt8(size: number, queries: Float32Array, nq: number): Promise<RunResult> {
  const before = rss();
  const t0 = performance.now();
  const codes = new Int8Array(size * DIM);
  const scales = new Float32Array(size);
  {
    const v = readRows(0, size);
    for (let i = 0; i < size; i++) {
      let m = 0;
      for (let d = 0; d < DIM; d++) m = Math.max(m, Math.abs(v[i * DIM + d]!));
      const sc = m / 127 || 1;
      scales[i] = sc;
      for (let d = 0; d < DIM; d++) codes[i * DIM + d] = Math.round(v[i * DIM + d]! / sc);
    }
  }
  const buildMs = performance.now() - t0;
  const after = rss();
  const times: number[] = [];
  const top: number[][] = [];
  const qc = new Int8Array(DIM);
  const scores = new Float32Array(size);
  for (let q = 0; q < nq; q++) {
    const qv = queries.subarray(q * DIM, (q + 1) * DIM);
    const s = performance.now();
    let m = 0;
    for (let d = 0; d < DIM; d++) m = Math.max(m, Math.abs(qv[d]!));
    const qs = m / 127 || 1;
    for (let d = 0; d < DIM; d++) qc[d] = Math.round(qv[d]! / qs);
    for (let i = 0; i < size; i++) {
      let dot = 0;
      const base = i * DIM;
      for (let d = 0; d < DIM; d++) dot += qc[d]! * codes[base + d]!;
      scores[i] = dot * scales[i]!;
    }
    const ids = topK(scores, K);
    times.push(performance.now() - s);
    top.push(ids);
  }
  return { engine: "int8", size, buildMs, ram: { dataMb: mb(size * (DIM + 4)), rssDeltaMb: mb(after - before), rssMb: mb(after), maxRssMb: round(process.resourceUsage().maxRSS / 1024) }, diskBytes: size * (DIM + 4), search: stats(times), top };
}

class Sidecar {
  private readonly proc = spawn(SIDECAR, [], { stdio: ["pipe", "pipe", "inherit"] });
  private readonly lines = createInterface({ input: this.proc.stdout! });
  private readonly waiting: ((l: string) => void)[] = [];
  constructor() {
    this.lines.on("line", (l) => this.waiting.shift()?.(l));
  }
  get pid(): number {
    return this.proc.pid!;
  }
  cmd(line: string): Promise<string> {
    return new Promise((res, rej) => {
      this.waiting.push((l) => (l.startsWith("ok") ? res(l.slice(3)) : rej(new Error(`${line.split(" ")[0]} : ${l}`))));
      this.proc.stdin!.write(`${line}\n`);
    });
  }
  memory(): { workingSetMb: number; peakWorkingSetMb: number } {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `$p = Get-Process -Id ${this.pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64)"`], { encoding: "utf8" }).trim();
    const [ws, peak] = out.split(/\s+/).map(Number);
    return { workingSetMb: mb(ws!), peakWorkingSetMb: mb(peak!) };
  }
  async close(): Promise<void> {
    this.proc.stdin!.end("quit\n");
    await new Promise((r) => this.proc.once("exit", r));
  }
}

const b64f = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

async function runTurbovec(engine: Engine, size: number, queries: Float32Array, nq: number): Promise<RunResult> {
  const bits = engine === "turbovec-2" ? 2 : 4;
  if (!existsSync(SIDECAR)) throw new Error(`sidecar absent : ${SIDECAR} (cargo build --release --offline)`);
  const tmp = join(Q15, "tmp", `${engine}-${size}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const sc = new Sidecar();
  try {
    await sc.cmd(`new ${DIM} ${bits}`);
    const empty = sc.memory();
    // TQ+ : 1 024 lignes tirées uniformément dans l'ensemble indexé, une fois, avant l'ingest.
    const next = rng(size);
    const sample = new Float32Array(Math.min(1024, size) * DIM);
    for (let i = 0; i < sample.length / DIM; i++) sample.set(readRows(Math.floor(next() * size), 1), i * DIM);
    const samplePath = join(tmp, "sample.f32");
    writeFileSync(samplePath, Buffer.from(sample.buffer));
    const t0 = performance.now();
    await sc.cmd(`calibrate ${samplePath}`);
    const calibrateMs = performance.now() - t0;
    const SLICE = 10_000;
    for (let from = 0; from < size; from += SLICE) {
      const rows = Math.min(SLICE, size - from);
      const vp = join(tmp, "slice.f32");
      const ip = join(tmp, "slice.u64");
      writeFileSync(vp, Buffer.from(readRows(from, rows).slice().buffer));
      const ids = new BigUint64Array(rows);
      for (let i = 0; i < rows; i++) ids[i] = BigInt(from + i);
      writeFileSync(ip, Buffer.from(ids.buffer));
      await sc.cmd(`addfile ${vp} ${ip}`);
    }
    await sc.cmd("prepare");
    const buildMs = performance.now() - t0;
    const loaded = sc.memory();
    const indexPath = join(tmp, "index.tv");
    await sc.cmd(`write ${indexPath}`);
    const diskBytes = statSync(indexPath).size;
    if (Number(await sc.cmd("len")) !== size) throw new Error("turbovec : taille inattendue");

    // Temps noyau : toutes les requêtes dans le sidecar.
    const qp = join(tmp, "queries.f32");
    writeFileSync(qp, Buffer.from(queries.slice(0, nq * DIM).buffer));
    const op = join(tmp, "out.u64");
    const bench = await sc.cmd(`benchsearch ${K} ${qp} ${op}`);
    const kernelUs = bench.split(" ")[1]!.split(",").map(Number);
    // Bout en bout : une requête par ligne stdio, comme le ferait l'adaptateur.
    const times: number[] = [];
    const top: number[][] = [];
    for (let q = 0; q < nq; q++) {
      const s = performance.now();
      const out = await sc.cmd(`search ${K} ${b64f(queries.subarray(q * DIM, (q + 1) * DIM))}`);
      times.push(performance.now() - s);
      top.push(out.split(" ").filter(Boolean).map((p) => Number(p.split(":")[0])));
    }
    // Cohérence : même résultat par stdio que dans le noyau.
    const kIds = new BigUint64Array(readFileSync(op).buffer.slice(0));
    const same = top.every((t, q) => t.every((id, i) => BigInt(id) === kIds[q * K + i]));
    if (!same) throw new Error("turbovec : benchsearch et search divergent");
    // Recherche filtrée : allowlist de 10³ ids tirés au hasard (profil / conversation / période).
    const allowIds = new Set<number>();
    const pick = rng(7);
    while (allowIds.size < Math.min(ALLOW, size)) allowIds.add(Math.floor(pick() * size));
    const allowB64 = Buffer.from(new BigUint64Array([...allowIds].map(BigInt)).buffer).toString("base64");
    const allowTimes: number[] = [];
    let allInAllow = true;
    for (let q = 0; q < Math.min(nq, 200); q++) {
      const s = performance.now();
      const out = await sc.cmd(`search ${K} ${b64f(queries.subarray(q * DIM, (q + 1) * DIM))} ${allowB64}`);
      allowTimes.push(performance.now() - s);
      if (!out.split(" ").filter(Boolean).every((p) => allowIds.has(Number(p.split(":")[0])))) allInAllow = false;
    }
    // Persistance (indicatif, hors critère) : sync complet, puis 100 ajouts + 100 suppressions et sync
    // incrémental ; rechargement vérifié (même taille, même premier résultat).
    const syncPath = join(tmp, "sync.tv");
    let s0 = performance.now();
    await sc.cmd(`sync ${syncPath}`);
    const firstSyncMs = performance.now() - s0;
    for (let i = 0; i < 100; i++) {
      await sc.cmd(`add ${10_000_000 + i} ${b64f(queries.subarray((200 + i) * DIM, (201 + i) * DIM))}`);
      await sc.cmd(`remove ${size - 1 - i}`);
    }
    await sc.cmd("prepare");
    s0 = performance.now();
    await sc.cmd(`sync ${syncPath}`);
    const incrSyncMs = performance.now() - s0;
    const probe = b64f(queries.subarray(0, DIM));
    const liveTop = (await sc.cmd(`search 1 ${probe}`)).split(":")[0];
    const reloaded = Number(await sc.cmd(`load ${syncPath}`));
    const loadedTop = (await sc.cmd(`search 1 ${probe}`)).split(":")[0];
    const persist = { firstSyncMs: round(firstSyncMs), incrSyncMs: round(incrSyncMs), fileBytes: statSync(syncPath).size, reloadOk: reloaded === size && liveTop === loadedTop };
    const final = sc.memory();
    return {
      engine,
      size,
      buildMs,
      ram: {
        dataMb: mb(diskBytes),
        emptyWorkingSetMb: empty.workingSetMb,
        workingSetMb: loaded.workingSetMb,
        workingSetDeltaMb: round(loaded.workingSetMb - empty.workingSetMb),
        peakWorkingSetMb: final.peakWorkingSetMb,
        calibrateMs: round(calibrateMs),
      },
      diskBytes,
      search: stats(times),
      kernel: stats(kernelUs.map((u) => u / 1000)),
      allow: { ...stats(allowTimes), allowSize: allowIds.size, allInAllow },
      persist,
      top,
    };
  } finally {
    await sc.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function child(engine: Engine, size: number): Promise<void> {
  const { queries } = corpusMeta();
  const nq = queries.length;
  const qv = readRows(0, nq, true).slice();
  const r =
    engine === "memory" ? await runMemory(size, qv, nq) : engine === "int8" ? await runInt8(size, qv, nq) : await runTurbovec(engine, size, qv, nq);
  writeFileSync(join(Q15, `run-${engine}-${size}.json`), JSON.stringify(r));
}

// ── Orchestration ──────────────────────────────────────────────────────────────────────────────

function spawnChild(engine: Engine, size: number): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ["--expose-gc", "--max-old-space-size=8192", "--import", "tsx", HERE, "--child", engine, String(size)], {
      cwd: dirname(HERE),
      stdio: "inherit",
    });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${engine} @ ${size} : code ${code}`))));
  });
}

async function main(): Promise<void> {
  const { chunks, total, queries } = corpusMeta();
  const report: Record<string, unknown> = {
    at: new Date().toISOString(),
    env: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length, totalMemMb: Math.round(totalmem() / 2 ** 20) },
    config: { dim: DIM, sizes: SIZES.filter((s) => s <= chunks), embeddedChunks: chunks, corpusChunks: total, k: K, queries: queries.length, allow: ALLOW, corpus: JSON.parse(readFileSync(join(Q15, "corpus.json"), "utf8")) },
    runs: [] as unknown[],
  };
  const known = queries.map((q, i) => ({ ...q, i })).filter((q) => q.target !== null);
  const table: string[] = [];
  const verdictRuns: VerdictRun[] = [];
  for (const size of SIZES) {
    if (size > chunks) continue;
    const results: Partial<Record<Engine, RunResult>> = {};
    const spread: Partial<Record<Engine, { p95Ms: number[]; ramMb: number[] }>> = {};
    for (const engine of ENGINES) {
      const reps: RunResult[] = [];
      for (let rep = 0; rep < REPS; rep++) {
        console.log(`[q15] ${engine} @ ${size} (${rep + 1}/${REPS})…`);
        await spawnChild(engine, size);
        const path = join(Q15, `run-${engine}-${size}.json`);
        reps.push(JSON.parse(readFileSync(path, "utf8")) as RunResult);
        rmSync(path);
      }
      // Médiane des répétitions pour p95 et RAM (mesures bruitées d'un processus à l'autre) ; le reste
      // (résultats, disque) est déterministe et pris dans la première.
      const ram = (r: RunResult) => r.ram.rssDeltaMb ?? r.ram.workingSetDeltaMb!;
      const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const first = reps[0]!;
      const p95s = reps.map((r) => r.search.p95Ms);
      const rams = reps.map(ram);
      results[engine] = {
        ...first,
        search: { ...first.search, p95Ms: med(p95s) },
        ram: { ...first.ram, [first.ram.rssDeltaMb !== undefined ? "rssDeltaMb" : "workingSetDeltaMb"]: med(rams) },
      };
      spread[engine] = { p95Ms: p95s, ramMb: rams };
    }
    const exact = results.memory!.top;
    for (const engine of ENGINES) {
      const r = results[engine]!;
      let at1 = 0;
      let at3 = 0;
      let p2at3 = 0;
      for (const q of known) {
        const t = r.top[q.i]!;
        if (t[0] === q.target) at1++;
        if (t.slice(0, 3).includes(q.target!)) {
          at3++;
          if (q.kind === "p2") p2at3++;
        }
      }
      let inter = 0;
      for (let q = 0; q < queries.length; q++) {
        const e = new Set(exact[q]);
        inter += r.top[q]!.filter((id) => e.has(id)).length;
      }
      const { top: _t, ...rest } = r;
      const run = {
        ...rest,
        repetitions: spread[engine],
        buildMs: round(r.buildMs),
        recall: {
          known: known.length,
          at1,
          at3,
          p2At3: p2at3,
          p2: known.filter((q) => q.kind === "p2").length,
          recallAt10VsExact: round(inter / (queries.length * K), 4),
        },
      };
      (report.runs as unknown[]).push(run);
      verdictRuns.push({ engine, size, p95Ms: r.search.p95Ms, ramMb: r.ram.rssDeltaMb ?? r.ram.workingSetDeltaMb!, at3, p2At3: p2at3, p2: run.recall.p2 });
      table.push(
        [
          String(size).padStart(6),
          engine.padEnd(10),
          `p95 ${String(r.search.p95Ms).padStart(8)} ms [${Math.min(...spread[engine]!.p95Ms)}–${Math.max(...spread[engine]!.p95Ms)}]`,
          r.kernel ? `noyau ${String(r.kernel.p95Ms).padStart(7)} ms` : " ".repeat(19),
          `RAM ${String(r.ram.rssDeltaMb ?? r.ram.workingSetDeltaMb).padStart(7)} Mo [${Math.min(...spread[engine]!.ramMb)}–${Math.max(...spread[engine]!.ramMb)}]`,
          `disque ${String(mb(r.diskBytes)).padStart(7)} Mo`,
          `@1 ${at1}/${known.length}`,
          `@3 ${at3}/${known.length} (P2 ${p2at3}/24)`,
          `r@10 ${run.recall.recallAt10VsExact}`,
          r.allow ? `allow p95 ${r.allow.p95Ms} ms${r.allow.allInAllow ? "" : " HORS LISTE"}` : "",
          r.persist ? `sync ${r.persist.firstSyncMs}/${r.persist.incrSyncMs} ms${r.persist.reloadOk ? "" : " RECHARGEMENT FAUX"}` : "",
        ].join("  "),
      );
    }
  }
  report.table = table;
  const verdicts = ENGINES.filter((e) => e.startsWith("turbovec")).map((e) => q15Verdict(e, verdictRuns));
  report.verdictRuns = verdictRuns;
  report.verdicts = verdicts;
  for (const v of verdicts) table.push(`verdict ${v.engine} : ${v.verdict}${v.reasons.length ? ` — ${v.reasons.join(" ; ")}` : ""}`);
  const out = join(ROOT, ".work", `q15-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(table.join("\n"));
  console.log(`[q15] rapport : ${out}`);
}

const args = process.argv.slice(2);
if (args[0] === "--child") {
  child(args[1] as Engine, Number(args[2])).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
