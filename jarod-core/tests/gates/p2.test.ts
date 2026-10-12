/**
 * GATE P2 (PLAN §6) — « `rag_search` p95 < 100 ms à 10⁴ chunks ; embeddings sur NPU vérifiés par
 * métriques ».
 *
 * Rien de simulé dans la chaîne mesurée : outil `rag_search` du registre réel → RagService (index
 * vectoriel) → HTTP `/v1/embeddings` (plugin-embeddings) → OpenVINO → NPU → vecteur → recherche dans
 * 10⁴ chunks d'une base chiffrée. 24 documents réels sont indexés par ce même chemin (embeddings NPU) ;
 * le reste des 10⁴ chunks sont des distracteurs (vecteurs unitaires aléatoires dim 1024) pour la taille.
 * Chaque requête-témoin doit retrouver SON document en tête malgré les 10⁴ distracteurs.
 *
 * Modèle : `tools/ov-bge-m3-int8` (bge-m3 exporté INT8 OpenVINO, fourni par l'utilisateur).
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { floatsToBlob } from "@jarod/plugin-rag";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterAll, describe, expect, it } from "vitest";
import { DOCS } from "./p2-docs.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const TOTAL = 10_000;
const DIM = 1024;
const QUERIES = 50;

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

const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[gate-p2] ${l}`);
};

afterAll(async () => {
  writeFileSync(join(ROOT, ".work", `gate-p2-report-${Date.now()}.txt`), `${report.join("\n")}\n`);
  await cleanup();
});

describe("GATE P2", () => {
  it("rag_search p95 < 100 ms à 10⁴ chunks, embeddings exécutés sur le NPU", { timeout: 900_000 }, async () => {
    expect(existsSync(MODEL), `modèle absent : ${MODEL}`).toBe(true);
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const p of discoverPlugins()) plugins[p.name] = {};
    plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
    plugins.scheduler = { autoStart: false };
    plugins.agent = { runtimeLock: false };
    plugins.embeddings = { modelDir: MODEL, port: 0 };
    const app = new JarodApp({ plugins });
    const started = await start(app);
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
      topK: 3,
      maxChunksPerDoc: 1,
    });
    log(`point d'accès embeddings ${k.embeddings.url}`);

    // 1. Documents réels : indexés par le vrai chemin (HTTP → OpenVINO), compilation NPU comprise.
    let t0 = Date.now();
    for (const [id, text] of DOCS) await k.rag.rag.ingest(text, { docId: id, source: id });
    log(`${DOCS.length} documents indexés en ${Date.now() - t0} ms (compilation NPU incluse)`);

    // 2. Distracteurs jusqu'à 10⁴ chunks.
    const real = db.get<{ n: number }>("SELECT count(*) AS n FROM rag_chunks")!.n;
    const next = rng(1234);
    t0 = Date.now();
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
    const total = db.get<{ n: number }>("SELECT count(*) AS n FROM rag_chunks")!.n;
    log(`${total} chunks dans la base (${real} réels + ${total - real} distracteurs, remplissage ${Date.now() - t0} ms)`);
    expect(total).toBe(TOTAL);

    // 3. rag_search, outil réel du registre : exactitude puis latence de bout en bout.
    const tool = k.tools.registry.get("rag_search")!;
    const ctx = { sessionId: "gate-p2", workspace: null };
    let correct = 0;
    for (const [id, , query] of DOCS) {
      const out = await tool.run({ query }, ctx);
      const top = /^\[[\d.]+\] (\S+)/.exec(out)?.[1];
      if (top === id) correct++;
      else log(`requête « ${query} » → ${top} (attendu ${id})`);
    }
    log(`exactitude : ${correct}/${DOCS.length} requêtes retrouvent leur document en tête parmi ${total} chunks`);
    expect(correct).toBeGreaterThanOrEqual(DOCS.length - 1);

    const times: number[] = [];
    for (let q = 0; q < QUERIES; q++) {
      const query = `${DOCS[q % DOCS.length]![2]} (${q})`;
      const s = performance.now();
      await tool.run({ query }, ctx);
      times.push(performance.now() - s);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.ceil(0.5 * times.length) - 1]!;
    const p95 = times[Math.ceil(0.95 * times.length) - 1]!;
    log(`rag_search bout en bout (${QUERIES} requêtes, ${total} chunks) : p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${times.at(-1)!.toFixed(1)} ms`);
    expect(p95).toBeLessThan(100);

    // 4. Métriques : le NPU a réellement servi, sans repli.
    const m = k.embeddings.metrics();
    log(`métriques embeddings : ${JSON.stringify(m)}`);
    expect(m.device["128"]).toBe("NPU");
    expect(m.attempts.filter((a) => !a.ok)).toEqual([]);
    expect(m.attempts.every((a) => a.device === "NPU")).toBe(true);
    // Q7 : sonde NPU vs CPU — 1 − cos ≤ 1 % sur chaque texte ET top-5 identique au CPU sur chaque requête.
    for (const a of m.attempts) {
      log(`sonde forme ${a.shape} (${a.device}) : 1 − cos max ${a.probe?.cosineGap.toPrecision(3)}, top-${a.probe?.topK} identique au CPU, marge CPU min ${a.probe?.margin.toPrecision(3)}`);
      expect(a.probe).toBeDefined();
      expect(a.probe!.cosineGap).toBeLessThanOrEqual(0.01);
      expect(a.probe!.topK).toBe(5);
    }
    expect(m.texts).toBeGreaterThanOrEqual(DOCS.length * 2 + QUERIES);
    expect(m.p95Ms).not.toBeNull();
    await stop(started);
    log("GATE P2 : verte");
  });
});
