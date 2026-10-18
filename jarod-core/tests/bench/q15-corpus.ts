/**
 * Corpus du bench Q15 (turbovec) : ~10⁵ chunks de textes LOCAUX et publics (décision utilisateur du
 * 2026-09-28 : « textes locaux publics »), embarqués UNE fois en bge-m3 INT8 sur le NPU, par le chemin
 * de la gate P2 (kernel réel → plugin embeddings → HTTP `/v1/embeddings` → OpenVINO → NPU ; la forme 512,
 * refusée par le NPU, passe sur GPU.0 comme en production — manifeste `embedding.deviceByShape`).
 *
 * Sources, par priorité (fichiers triés, au plus PER_FILE chunks par fichier pour varier) :
 *   1. documentation des paquets npm installés (`node_modules/.pnpm/**` : .md, .markdown, .txt) ;
 *   2. fichiers suivis du dépôt (.ts, .tsx, .md, .mjs, .json) ;
 *   3. déclarations TypeScript des paquets installés (.d.ts) ;
 *   4. sources des crates Rust du cache Cargo local (.md puis .rs).
 * Découpage : `chunkText` de plugin-rag (800 caractères, sans recouvrement : réglages par défaut du RAG),
 * dédoublonnage par SHA-256, chunks de moins de 80 caractères non blancs écartés.
 *
 * Requêtes à cible connue (rappel « style gate P2 ») :
 *   - les 24 documents-témoins de la gate P2 et leur requête (placés parmi les 10³ premiers chunks) ;
 *   - 176 extraits : ~200 caractères du milieu d'un chunk des 10³ premiers, qui doit se retrouver.
 * Requêtes de rappel contre la recherche exacte : les mêmes 200, plus 1 000 chunks TENUS HORS de l'index.
 * Les 10³ premiers chunks sont dans toutes les tailles (10³ ⊂ 10⁴ ⊂ 10⁵ : préfixes).
 *
 * Sorties dans `.work/q15/` (ignoré par Git) : `chunks.jsonl`, `queries.json`, `vectors.f32` (petit-boutien :
 * d'abord les requêtes, puis le chunk i à la ligne requêtes + i — un fichier partiel sert déjà les petites
 * tailles), `corpus.json` (manifeste). L'embedding REPREND où il s'est arrêté.
 *
 *     pnpm --filter @jarod/gates bench:q15-corpus
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { chunkText, readEmbeddings, sha256 } from "@jarod/plugin-rag";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { DOCS } from "../gates/p2-docs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const Q15_DIR = join(ROOT, ".work", "q15");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
export const DIM = 1024;
export const INDEX_SIZE = 100_000;
const HELD_OUT = 1_000;
const SNIPPETS = 176;
const PER_FILE = 40;
const CHUNK = 800;
const BATCH = 32;

export interface Chunk {
  id: number;
  source: string;
  text: string;
}
export interface Query {
  text: string;
  /** Chunk attendu (rappel à cible connue) ; null pour les chunks tenus hors de l'index. */
  target: number | null;
  kind: "p2" | "snippet" | "heldout";
}

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

function walk(dir: string, keep: (name: string) => boolean, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, keep, out);
    else if (st.isFile() && st.size >= 200 && st.size <= 2_000_000 && keep(name)) out.push(p);
  }
}

function sources(): { label: string; files: string[] }[] {
  const nm = join(ROOT, "node_modules", ".pnpm");
  const docs: string[] = [];
  walk(nm, (n) => /\.(md|markdown|txt)$/i.test(n), docs);
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx|md|mjs|json)$/.test(f) && !f.endsWith("pnpm-lock.yaml"))
    .map((f) => join(ROOT, f))
    .filter((f) => existsSync(f));
  const dts: string[] = [];
  walk(nm, (n) => n.endsWith(".d.ts"), dts);
  const cargo = join(homedir(), ".cargo", "registry", "src");
  const rsDocs: string[] = [];
  walk(cargo, (n) => /\.md$/i.test(n), rsDocs);
  const rs: string[] = [];
  walk(cargo, (n) => n.endsWith(".rs"), rs);
  return [
    { label: "npm-docs", files: docs },
    { label: "repo", files: tracked },
    { label: "npm-dts", files: dts },
    { label: "cargo-docs", files: rsDocs },
    { label: "cargo-rs", files: rs },
  ];
}

function build(): { chunks: Chunk[]; queries: Query[]; manifest: Record<string, unknown> } {
  const seen = new Set<string>();
  const pool: Omit<Chunk, "id">[] = [];
  const perSource: Record<string, { files: number; chunks: number }> = {};
  const need = INDEX_SIZE + HELD_OUT;
  for (const { label, files } of sources()) {
    perSource[label] = { files: 0, chunks: 0 };
    for (const f of files) {
      if (pool.length >= need * 1.05) break;
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      let taken = 0;
      for (const piece of chunkText(text, CHUNK, 0)) {
        if (taken >= PER_FILE) break;
        if (piece.replace(/\s/g, "").length < 80) continue;
        const h = sha256(piece);
        if (seen.has(h)) continue;
        seen.add(h);
        pool.push({ source: `${label}:${relative(ROOT, f).replaceAll("\\", "/")}`, text: piece });
        taken++;
      }
      if (taken) {
        perSource[label]!.files++;
        perSource[label]!.chunks += taken;
      }
    }
  }
  if (pool.length < need) throw new Error(`corpus insuffisant : ${pool.length} chunks < ${need}`);
  // Mélange déterministe (Fisher-Yates), puis coupe : index d'abord, chunks tenus hors ensuite.
  const next = rng(1515);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const indexed = pool.slice(0, INDEX_SIZE);
  const held = pool.slice(INDEX_SIZE, need);
  // Les 24 documents P2 remplacent un chunk sur 40 des 10³ premiers.
  const queries: Query[] = [];
  DOCS.forEach(([id, text, query], i) => {
    const at = 20 + i * 40;
    indexed[at] = { source: `p2:${id}`, text };
    queries.push({ text: query, target: at, kind: "p2" });
  });
  const p2At = new Set(queries.map((q) => q.target));
  const cand = Array.from({ length: 1000 }, (_, i) => i).filter((i) => !p2At.has(i));
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [cand[i], cand[j]] = [cand[j]!, cand[i]!];
  }
  for (const at of cand.slice(0, SNIPPETS)) {
    const t = indexed[at]!.text;
    const mid = Math.floor(t.length / 2);
    let s = Math.max(0, mid - 100);
    const sp = t.indexOf(" ", s);
    if (sp > 0 && sp < mid) s = sp + 1;
    queries.push({ text: t.slice(s, s + 200).trim(), target: at, kind: "snippet" });
  }
  for (const h of held) queries.push({ text: h.text, target: null, kind: "heldout" });
  const chunks = indexed.map((c, id) => ({ id, ...c }));
  const manifest = {
    at: new Date().toISOString(),
    model: "tools/ov-bge-m3-int8",
    dim: DIM,
    chunkSize: CHUNK,
    overlap: 0,
    perFile: PER_FILE,
    indexSize: chunks.length,
    queries: { p2: DOCS.length, snippet: SNIPPETS, heldout: held.length },
    perSource,
    poolSize: pool.length,
  };
  return { chunks, queries, manifest };
}

async function main(): Promise<void> {
  mkdirSync(Q15_DIR, { recursive: true });
  const chunksPath = join(Q15_DIR, "chunks.jsonl");
  const queriesPath = join(Q15_DIR, "queries.json");
  const vecPath = join(Q15_DIR, "vectors.f32");
  if (!existsSync(chunksPath) || !existsSync(queriesPath)) {
    const t0 = performance.now();
    const { chunks, queries, manifest } = build();
    writeFileSync(chunksPath, chunks.map((c) => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(queriesPath, JSON.stringify(queries));
    writeFileSync(join(Q15_DIR, "corpus.json"), JSON.stringify({ ...manifest, buildMs: Math.round(performance.now() - t0) }, null, 2) + "\n");
    console.log(`[q15-corpus] corpus construit : ${chunks.length} chunks, ${queries.length} requêtes`);
  }
  const chunks = readFileSync(chunksPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Chunk);
  const queries = JSON.parse(readFileSync(queriesPath, "utf8")) as Query[];
  const texts = [...queries.map((q) => q.text), ...chunks.map((c) => c.text)];
  const rowBytes = DIM * 4;
  const done = existsSync(vecPath) ? Math.floor(statSync(vecPath).size / rowBytes) : 0;
  if (existsSync(vecPath) && statSync(vecPath).size % rowBytes) throw new Error("vectors.f32 tronqué au milieu d'une ligne");
  if (done >= texts.length) {
    console.log(`[q15-corpus] déjà complet : ${done} vecteurs`);
    return;
  }
  if (!existsSync(MODEL)) throw new Error(`modèle absent : ${MODEL}`);

  const dataDir = tempDir();
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir, keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.agent = { runtimeLock: false };
  plugins.embeddings = { modelDir: MODEL, port: 0 };
  const app = new JarodApp({ plugins });
  const started = await start(app);
  const emb = (app as unknown as { embeddings: { url: string; metrics(): EmbeddingsMetrics } }).embeddings;
  const t0 = performance.now();
  let n = done;
  try {
    while (n < texts.length) {
      const batch = texts.slice(n, n + BATCH);
      const res = await fetch(`${emb.url}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "bge-m3-int8-ov", input: batch }),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status} : ${await res.text()}`);
      const vs = readEmbeddings(await res.json());
      if (vs.length !== batch.length || vs.some((v) => v.length !== DIM)) throw new Error("réponse d'embeddings incomplète");
      const out = new Float32Array(vs.length * DIM);
      vs.forEach((v, i) => { out.set(v, i * DIM); });
      appendFileSync(vecPath, Buffer.from(out.buffer));
      n += vs.length;
      if (Math.floor(n / 2000) !== Math.floor((n - vs.length) / 2000)) {
        const rate = (n - done) / ((performance.now() - t0) / 1000);
        console.log(`[q15-corpus] ${n}/${texts.length} (${rate.toFixed(1)}/s, reste ~${Math.round((texts.length - n) / rate / 60)} min)`);
      }
    }
    const m = emb.metrics();
    // Périphérique PAR FORME, consigné tel quel : constaté le 2026-09-28, la forme 512 (chunks de plus de
    // 128 tokens) est refusée par le NPU et compilée sur GPU.0 (sonde de fidélité vs CPU passée) — c'est
    // aussi le chemin de production. Un repli sur CPU, lui, reste une erreur.
    const failed = m.attempts.filter((a) => !a.ok).map(({ shape, device, error }) => ({ shape, device, error }));
    const manifestPath = join(Q15_DIR, "corpus.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, embedding: { deviceByShape: m.device, failedAttempts: failed, lastRunMs: Math.round(performance.now() - t0), lastRunRows: n - done } }, null, 2) + "\n",
    );
    console.log(`[q15-corpus] terminé : ${n} vecteurs ; formes ${JSON.stringify(m.device)} ; refus ${JSON.stringify(failed)}`);
    if (Object.values(m.device).some((d) => d === "CPU")) throw new Error(`embedding sur CPU : ${JSON.stringify(m.device)}`);
  } finally {
    await stop(started);
    await cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
