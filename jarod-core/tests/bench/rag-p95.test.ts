/**
 * Bench G2 (PLAN §3, gap-reel G2) : latence de `RagService.search` en fonction du nombre de chunks,
 * mesurée AVANT toute optimisation. Base réelle chiffrée (plugin-storage), vecteurs dim 1024
 * (bge-m3), 10 chunks par document, 50 requêtes après 3 d'échauffement.
 *
 * L'embedder de la requête est instantané ici : on mesure le coût de RECHERCHE (lecture, désérialisation,
 * scoring, tri). Le coût d'embedding (NPU) est mesuré à part par plugin-embeddings.
 *
 *     pnpm --filter @jarod/gates bench:rag            (défaut 10³, 10⁴, 10⁵)
 *     RAG_BENCH_SIZES=1000,10000 pnpm --filter @jarod/gates bench:rag
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import type { RagService } from "@jarod/plugin-rag";
import { floatsToBlob } from "@jarod/plugin-rag";
import { type Db, memoryKeyStore, type SettingsService } from "@jarod/plugin-storage";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIM = 1024;
const SIZES = (process.env.RAG_BENCH_SIZES ?? "1000,10000,100000").split(",").map(Number);
const QUERIES = 50;
const WARMUP = 3;

/** Générateur déterministe (mulberry32) : même base à chaque exécution. */
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

function unitVector(next: () => number): Float32Array {
  const v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = next() * 2 - 1;
    n += v[i]! * v[i]!;
  }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < DIM; i++) v[i]! *= inv;
  return v;
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
export const results: { chunks: number; p50: number; p95: number; max: number; fill: number }[] = [];

afterAll(async () => {
  const lines = results.map((r) => `${r.chunks}\tp50=${r.p50.toFixed(1)}ms\tp95=${r.p95.toFixed(1)}ms\tmax=${r.max.toFixed(1)}ms\t(remplissage ${r.fill} ms)`);
  writeFileSync(join(ROOT, ".work", `bench-rag-${process.env.RAG_BENCH_LABEL ?? "scan"}-${Date.now()}.txt`), `${lines.join("\n")}\n`);
  await cleanup();
});

describe(`bench rag_search (${process.env.RAG_BENCH_LABEL ?? "balayage complet"})`, () => {
  for (const n of SIZES) {
    it(`${n} chunks`, { timeout: 900_000 }, async () => {
      const app = new JarodApp({
        plugins: { storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} },
      });
      const started = await start(app);
      const ctx = app as unknown as { storage: { db: Db; settings: SettingsService }; rag: { rag: RagService } };
      const { db, settings } = ctx.storage;
      settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 5, maxChunksPerDoc: 2 });
      const next = rng(42);
      const t0 = Date.now();
      db.tx(() => {
        for (let i = 0; i < n; i++) {
          db.run(
            "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            `doc-${Math.floor(i / 10)}`,
            i % 10,
            `chunk ${i}`,
            DIM,
            floatsToBlob(unitVector(next)),
            `h${Math.floor(i / 10)}`,
            "bench",
            "bench-1024",
            Date.now(),
          );
        }
      });
      const fill = Date.now() - t0;
      const rag = ctx.rag.rag;
      const qnext = rng(7);
      rag.setEmbedder(async (texts) => texts.map(() => unitVector(qnext)));
      const times: number[] = [];
      for (let q = 0; q < WARMUP + QUERIES; q++) {
        const s = performance.now();
        const hits = await rag.search(`requête ${q}`);
        const dt = performance.now() - s;
        expect(hits.length).toBe(5);
        if (q >= WARMUP) times.push(dt);
      }
      times.sort((a, b) => a - b);
      const r = { chunks: n, p50: pct(times, 50), p95: pct(times, 95), max: times.at(-1)!, fill };
      results.push(r);
      console.log(`[bench-rag] ${n} chunks : p50=${r.p50.toFixed(1)} ms p95=${r.p95.toFixed(1)} ms max=${r.max.toFixed(1)} ms`);
      await stop(started);
    });
  }
});
