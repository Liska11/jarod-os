/**
 * Jeu de requêtes D du bench C0 (comparateur hybride dense + FTS5) : 200 requêtes « mots-clés » à cible connue, sur
 * le corpus Q15 (`.work/q15/`). La règle de construction est FIGÉE dans DECISIONS (2026-09-29, « C0 — critères et
 * barres figés avant toute mesure ») ; elle n'est pas retouchée après avoir vu un chiffre :
 *   - graine 2026 (générateur de `q15-corpus`), chunks tirés parmi les indices 0-999, privés des 24 emplacements P2
 *     (20 + 40 i) et des cibles des extraits ;
 *   - jetons = /[\p{L}\p{N}]{5,}/gu, minuscules, sans diacritiques (NFD) ;
 *   - df = nombre de chunks des 10⁵ contenant le jeton EXACT ; on garde df ∈ [1 ; 20], triés (df croissant, puis
 *     alphabétique) ; les TROIS premiers forment la requête (séparés par une espace) ; sans trois jetons : chunk passé ;
 *   - succès = un chunk contenant les trois jetons figure dans les k premiers (ensemble `acceptable`, indices du corpus).
 * D favorise le lexical par construction : c'est un jeu de contrainte, pas une mesure d'usage.
 *
 * Les requêtes sont ensuite embarquées UNE fois par le chemin de production (kernel → plugin embeddings → HTTP →
 * OpenVINO), comme le corpus Q15. Sorties dans `.work/c0/` (ignoré par Git) : `keyword-queries.json`,
 * `keyword-vectors.f32` (une ligne de 1 024 flottants par requête).
 *
 *     pnpm --filter @jarod/gates bench:c0-corpus
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { readEmbeddings } from "@jarod/plugin-rag";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { DIM, Q15_DIR, type Chunk, type Query } from "./q15-corpus.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const C0_DIR = join(ROOT, ".work", "c0");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
export const KEYWORD_QUERIES = 200;
const SEED = 2026;
const MAX_DF = 20;
const TOKEN = /[\p{L}\p{N}]{5,}/gu;

export interface KeywordQuery {
  text: string;
  tokens: string[];
  /** Chunk d'où viennent les jetons. */
  target: number;
  /** Tous les chunks du corpus (indices) qui contiennent les trois jetons. */
  acceptable: number[];
}

/** Même générateur que `q15-corpus.ts` (mulberry32) : recopié, pas exporté là-bas. */
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

/** Jetons d'un texte : minuscules, sans diacritiques, au moins 5 lettres/chiffres, dédoublonnés. */
export function tokensOf(text: string): Set<string> {
  const flat = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  return new Set(flat.match(TOKEN) ?? []);
}

export function buildKeywordQueries(chunks: readonly Chunk[], queries: readonly Query[]): KeywordQuery[] {
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of tokensOf(c.text)) df.set(t, (df.get(t) ?? 0) + 1);
  const p2Slots = new Set(queries.filter((q) => q.kind === "p2").map((q) => q.target));
  const snippetTargets = new Set(queries.filter((q) => q.kind === "snippet").map((q) => q.target));
  const pool = Array.from({ length: 1000 }, (_, i) => i).filter((i) => !p2Slots.has(i) && !snippetTargets.has(i));
  const next = rng(SEED);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const picked: { target: number; tokens: string[] }[] = [];
  for (const at of pool) {
    if (picked.length >= KEYWORD_QUERIES) break;
    const eligible = [...tokensOf(chunks[at]!.text)]
      .filter((t) => (df.get(t) ?? 0) >= 1 && (df.get(t) ?? 0) <= MAX_DF)
      .sort((a, b) => df.get(a)! - df.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
    if (eligible.length >= 3) picked.push({ target: at, tokens: eligible.slice(0, 3) });
  }
  if (picked.length < KEYWORD_QUERIES) throw new Error(`jeu D insuffisant : ${picked.length} requêtes`);
  const need = new Map<string, number[]>();
  for (const p of picked) for (const t of p.tokens) need.set(t, []);
  chunks.forEach((c, i) => {
    for (const t of tokensOf(c.text)) need.get(t)?.push(i);
  });
  return picked.map(({ target, tokens }) => {
    const lists = tokens.map((t) => new Set(need.get(t)!));
    const acceptable = [...lists[0]!].filter((i) => lists[1]!.has(i) && lists[2]!.has(i)).sort((a, b) => a - b);
    return { text: tokens.join(" "), tokens, target, acceptable };
  });
}

async function main(): Promise<void> {
  mkdirSync(C0_DIR, { recursive: true });
  const qPath = join(C0_DIR, "keyword-queries.json");
  const vPath = join(C0_DIR, "keyword-vectors.f32");
  const chunks = readFileSync(join(Q15_DIR, "chunks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Chunk);
  const queries = JSON.parse(readFileSync(join(Q15_DIR, "queries.json"), "utf8")) as Query[];
  if (!existsSync(qPath)) {
    const t0 = performance.now();
    const kw = buildKeywordQueries(chunks, queries);
    writeFileSync(qPath, JSON.stringify(kw));
    const sizes = kw.map((k) => k.acceptable.length);
    console.log(
      `[c0-corpus] ${kw.length} requêtes de mots-clés (${Math.round(performance.now() - t0)} ms) ; cibles acceptables : min ${Math.min(...sizes)}, max ${Math.max(...sizes)}, médiane ${sizes.sort((a, b) => a - b)[sizes.length >> 1]}`,
    );
  }
  const kw = JSON.parse(readFileSync(qPath, "utf8")) as KeywordQuery[];
  const rowBytes = DIM * 4;
  if (existsSync(vPath) && statSync(vPath).size === kw.length * rowBytes) {
    console.log(`[c0-corpus] déjà complet : ${kw.length} vecteurs`);
    return;
  }
  if (!existsSync(MODEL)) throw new Error(`modèle absent : ${MODEL}`);
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.agent = { runtimeLock: false };
  plugins.embeddings = { modelDir: MODEL, port: 0 };
  const app = new JarodApp({ plugins });
  const started = await start(app);
  const emb = (app as unknown as { embeddings: { url: string; metrics(): EmbeddingsMetrics } }).embeddings;
  try {
    writeFileSync(vPath, new Uint8Array(0));
    for (let n = 0; n < kw.length; n += 32) {
      const batch = kw.slice(n, n + 32).map((k) => k.text);
      const res = await fetch(`${emb.url}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "bge-m3-int8-ov", input: batch }),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status} : ${await res.text()}`);
      const vs = readEmbeddings(await res.json());
      if (vs.length !== batch.length || vs.some((v) => v.length !== DIM)) throw new Error("réponse d'embeddings incomplète");
      const out = new Float32Array(vs.length * DIM);
      vs.forEach((v, i) => out.set(v, i * DIM));
      appendFileSync(vPath, Buffer.from(out.buffer));
    }
    const m = emb.metrics();
    console.log(`[c0-corpus] ${kw.length} vecteurs ; formes ${JSON.stringify(m.device)}`);
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
