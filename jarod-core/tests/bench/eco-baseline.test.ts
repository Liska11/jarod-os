/**
 * Banc de référence écosystème (PLAN §10, phase 0) : chiffres de la pile ACTUELLE avant tout moteur
 * nouveau. AUCUN SEUIL : rien n'échoue sur une valeur mesurée ; seules les préconditions (modèle
 * présent, 10⁴ chunks en base) sont vérifiées. Jamais dans `pnpm test` (hors vitest.integration.config).
 *
 * Même chemin que la gate P2 (gates/p2.test.ts) : outil `rag_search` du registre réel → RagService →
 * HTTP `/v1/embeddings` → OpenVINO → NPU (bge-m3 INT8, `tools/ov-bge-m3-int8`) → recherche dans 10⁴ chunks
 * d'une base chiffrée. Les 24 documents-témoins et leurs requêtes sont ceux de la gate P2.
 *
 * Relevé : temps d'ingestion, p50/p95/max de `rag_search`, RAM (rss, heap), disque (base, WAL, SHM),
 * rappel@1 et rappel@3, erreurs et replis (tentatives d'embeddings échouées ou hors NPU).
 * Rapport JSON dans `.work/eco-baseline-<horodatage>.json` (ignoré par Git).
 *
 *     pnpm --filter @jarod/gates bench:eco
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { floatsToBlob } from "@jarod/plugin-rag";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterAll, describe, expect, it } from "vitest";
import { DOCS } from "../gates/p2-docs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const TOTAL = 10_000;
const DIM = 1024;
const QUERIES = 50;
const TOP_K = 3;

/** Générateur déterministe (mulberry32), même graine que la gate P2 : mêmes distracteurs. */
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

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
const round = (v: number) => Math.round(v * 10) / 10;
const mem = () => {
  const m = process.memoryUsage();
  return { rssMb: round(m.rss / 2 ** 20), heapUsedMb: round(m.heapUsed / 2 ** 20), heapTotalMb: round(m.heapTotal / 2 ** 20) };
};
const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);
const disk = (dir: string) => {
  const db = join(dir, "jarod.db");
  return { dbBytes: size(db), walBytes: size(`${db}-wal`), shmBytes: size(`${db}-shm`) };
};

const report: Record<string, unknown> = {};

afterAll(async () => {
  if (Object.keys(report).length) {
    const out = join(ROOT, ".work", `eco-baseline-${Date.now()}.json`);
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[eco-baseline] rapport : ${out}`);
  }
  await cleanup();
});

describe("banc de référence écosystème (pile actuelle, sans seuil)", () => {
  it("ingestion, rag_search, RAM, disque, rappel, erreurs et replis à 10⁴ chunks", { timeout: 900_000 }, async () => {
    expect(existsSync(MODEL), `modèle absent : ${MODEL}`).toBe(true);
    report.at = new Date().toISOString();
    report.env = { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null, cpus: cpus().length, totalMemMb: Math.round(totalmem() / 2 ** 20) };
    report.config = { model: "tools/ov-bge-m3-int8", totalChunks: TOTAL, dim: DIM, docs: DOCS.length, latencyQueries: QUERIES, topK: TOP_K, maxChunksPerDoc: 1 };
    const memory: Record<string, unknown> = { beforeStart: mem() };

    const dataDir = tempDir();
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir, keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.agent = { runtimeLock: false };
    plugins.embeddings = { modelDir: MODEL, port: 0 };
    const app = new JarodApp({ plugins });
    let t0 = performance.now();
    const started = await start(app);
    const startMs = performance.now() - t0;
    memory.afterStart = mem();
    const k = app as unknown as {
      storage: { db: import("@jarod/plugin-storage").Db; settings: import("@jarod/plugin-storage").SettingsService };
      rag: { rag: import("@jarod/plugin-rag").RagService };
      embeddings: { url: string; metrics(): EmbeddingsMetrics };
      tools: { registry: import("@jarod/plugin-tools").ToolRegistry };
    };
    const { db, settings } = k.storage;
    settings.set("rag", {
      ...settings.get("rag"),
      enabled: true,
      embeddingsUrl: k.embeddings.url,
      embeddingsModel: "bge-m3-int8-ov",
      topK: TOP_K,
      maxChunksPerDoc: 1,
    });

    // 1. Ingestion réelle des 24 documents (HTTP → OpenVINO → NPU), le premier inclut la compilation.
    const errors: { stage: string; code: string }[] = [];
    const perDoc: number[] = [];
    t0 = performance.now();
    for (const [id, text] of DOCS) {
      const s = performance.now();
      try {
        await k.rag.rag.ingest(text, { docId: id, source: id });
      } catch (e) {
        errors.push({ stage: "ingest", code: String((e as Error).message).split(":")[0]!.slice(0, 64) });
      }
      perDoc.push(performance.now() - s);
    }
    const ingestTotal = performance.now() - t0;
    memory.afterIngest = mem();

    // 2. Distracteurs jusqu'à 10⁴ chunks (vecteurs unitaires aléatoires, écrits directement en base).
    const real = db.get<{ n: number }>("SELECT count(*) AS n FROM rag_chunks")!.n;
    const next = rng(1234);
    t0 = performance.now();
    db.tx(() => {
      for (let i = 0; i < TOTAL - real; i++) {
        const v = new Float32Array(DIM);
        let n = 0;
        for (let d = 0; d < DIM; d++) {
          v[d] = next() * 2 - 1;
          n += v[d]! * v[d]!;
        }
        const inv = 1 / Math.sqrt(n);
        for (let d = 0; d < DIM; d++) v[d]! *= inv;
        db.run(
          "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          `bruit-${i}`,
          0,
          `bruit ${i}`,
          DIM,
          floatsToBlob(v),
          `b${i}`,
          "bruit",
          "bge-m3-int8-ov",
          Date.now(),
        );
      }
    });
    const fillMs = performance.now() - t0;
    const total = db.get<{ n: number }>("SELECT count(*) AS n FROM rag_chunks")!.n;
    expect(total).toBe(TOTAL); // Précondition de taille, pas un seuil de performance.
    memory.afterFill = mem();
    const diskAfterFill = disk(dataDir);
    report.ingestion = {
      realDocs: DOCS.length,
      realChunks: real,
      totalMs: round(ingestTotal),
      firstDocMs: round(perDoc[0] ?? 0),
      perDocAfterFirst: (() => {
        const s = perDoc.slice(1).sort((a, b) => a - b);
        return s.length ? { p50Ms: round(pct(s, 50)), p95Ms: round(pct(s, 95)), maxMs: round(s.at(-1)!) } : null;
      })(),
      distractors: total - real,
      distractorFillMs: round(fillMs),
      appStartMs: round(startMs),
    };

    // 3. Rappel@1 et rappel@3 : chaque requête-témoin doit retrouver SON document.
    const tool = k.tools.registry.get("rag_search")!;
    const ctx = { sessionId: "eco-baseline", workspace: null };
    let at1 = 0;
    let at3 = 0;
    const misses: { expected: string; top: string[] }[] = [];
    t0 = performance.now();
    for (const [id, , query] of DOCS) {
      try {
        const out = await tool.run({ query }, ctx);
        const top = [...out.matchAll(/^\[[\d.]+\] (\S+)/gm)].map((m) => m[1]!);
        if (top[0] === id) at1++;
        if (top.slice(0, TOP_K).includes(id)) at3++;
        else misses.push({ expected: id, top: top.slice(0, TOP_K) });
      } catch (e) {
        errors.push({ stage: "recall", code: String((e as Error).message).split(":")[0]!.slice(0, 64) });
      }
    }
    const firstSearchesMs = performance.now() - t0;
    report.recall = { queries: DOCS.length, at1, at3, recallAt1: at1 / DOCS.length, recallAt3: at3 / DOCS.length, missesAt3: misses, firstPassMs: round(firstSearchesMs) };

    // 4. Latence de bout en bout de rag_search (index chaud).
    const times: number[] = [];
    for (let q = 0; q < QUERIES; q++) {
      const query = `${DOCS[q % DOCS.length]![2]} (${q})`;
      const s = performance.now();
      try {
        await tool.run({ query }, ctx);
      } catch (e) {
        errors.push({ stage: "latency", code: String((e as Error).message).split(":")[0]!.slice(0, 64) });
      }
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    report.ragSearch = { queries: QUERIES, chunks: total, p50Ms: round(pct(times, 50)), p95Ms: round(pct(times, 95)), maxMs: round(times.at(-1)!) };
    memory.afterSearch = mem();

    // 5. Embeddings : périphérique effectif, replis (tentative échouée ou hors NPU), latence du service.
    const m = k.embeddings.metrics();
    const fallbacks = m.attempts.filter((a) => !a.ok || a.device !== "NPU");
    report.embeddings = {
      requested: m.requested,
      device: m.device,
      calls: m.calls,
      texts: m.texts,
      p50Ms: m.p50Ms,
      p95Ms: m.p95Ms,
      attempts: m.attempts.map((a) => ({ shape: a.shape, device: a.device, ok: a.ok, ms: a.ms, cosineGap: a.probe?.cosineGap ?? null, topK: a.probe?.topK ?? null })),
      fallbacks: fallbacks.length,
      lastError: m.lastError === null ? null : m.lastError.split(":")[0]!.slice(0, 64),
    };
    report.errors = { count: errors.length, items: errors };

    // 6. Disque après les recherches, puis après un point de reprise WAL (taille consolidée).
    const diskAfterSearch = disk(dataDir);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    report.disk = { afterFill: diskAfterFill, afterSearch: diskAfterSearch, afterCheckpoint: disk(dataDir) };
    report.memory = memory;
    await stop(started);

    console.log(`[eco-baseline] ${JSON.stringify({ ingestion: report.ingestion, ragSearch: report.ragSearch, recall: { at1, at3 }, errors: errors.length, fallbacks: fallbacks.length })}`);
  });
});
