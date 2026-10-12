// Phase 1 (PLAN §10, Q15) : le mode fantôme ne change rien à ce qui est servi, suit SQLite par ids, et dégrade.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ChunkId, EngineInfo, IndexSpec, VectorHit, VectorRow, VectorSearchRequest } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { cosine, floatsToBlob, RagService } from "../src/rag.js";
import { type ShadowProvider, VectorShadow } from "../src/shadow.js";
import { TurbovecProvider } from "../src/turbovec.js";

afterEach(cleanup);

const DIM = 64;
const BIN = join(import.meta.dirname, "../../../../sidecars/turbovec/target/release/turbovec-sidecar.exe");

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
const vec = (next: () => number) => Float32Array.from({ length: DIM }, () => next() * 2 - 1);

/** Moteur exact en mémoire : le fantôme doit alors recouvrir exactement le servi. */
class ExactProvider implements ShadowProvider {
  readonly kind = "memory" as const;
  available = true;
  rows = new Map<number, Float32Array>();
  removed: number[] = [];
  rebuilds = 0;
  failWith: string | null = null;
  info(): EngineInfo {
    return { name: "exact", version: "1" };
  }
  async create(_spec: IndexSpec): Promise<void> {
    this.rows.clear();
  }
  async upsert(_id: string, rows: readonly VectorRow[]): Promise<void> {
    for (const r of rows) this.rows.set(r.id, r.vector);
  }
  async remove(_id: string, ids: readonly ChunkId[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
    this.removed.push(...ids);
  }
  async search(req: VectorSearchRequest): Promise<VectorHit[]> {
    if (this.failWith) throw Object.assign(new Error("panne"), { code: this.failWith });
    return [...this.rows]
      .map(([id, v]) => ({ id, score: cosine(req.vector, v) }))
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, req.k);
  }
  async sync(indexId: string) {
    return { indexId, generation: "g", size: this.rows.size, at: 0 };
  }
  async verify(indexId: string) {
    return { indexId, ok: true, size: this.rows.size, generation: "g" };
  }
  async rebuild(spec: IndexSpec, rows: AsyncIterable<VectorRow> | Iterable<VectorRow>) {
    this.rebuilds++;
    await this.create(spec);
    for await (const r of rows) this.rows.set(r.id, r.vector);
    return this.sync(spec.indexId);
  }
  async close(): Promise<void> {}
}

async function setup(provider: ShadowProvider, kind: "memory" | "turbovec" = "memory") {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 8, maxChunksPerDoc: 2 });
  const insert = (doc: string, ord: number, v: Float32Array) =>
    db.run(
      "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      doc,
      ord,
      `${doc}#${ord}`,
      DIM,
      floatsToBlob(v),
      doc,
      "test",
      "bge-m3-int8-ov",
      1,
    );
  const shadow = new VectorShadow(db, kind, provider);
  const withShadow = new RagService({ db, settings, providers: { def: () => ({ local: true }) as never }, shadow });
  const plain = new RagService({ db, settings, providers: { def: () => ({ local: true }) as never } });
  const flag = (on: boolean) => settings.set("ecosystem", { ...settings.get("ecosystem"), vectorShadow: on ? kind : null });
  return { db, insert, shadow, withShadow, plain, flag };
}

describe("mode fantôme de l'index vectoriel", () => {
  it("ne change rien aux résultats servis ; un moteur exact recouvre exactement le top-k", async () => {
    const p = new ExactProvider();
    const { insert, shadow, withShadow, plain, flag } = await setup(p);
    const next = rng(5);
    for (let i = 0; i < 200; i++) insert(`d${i % 30}`, Math.floor(i / 30), vec(next));
    flag(true);
    const q = rng(11);
    for (let n = 0; n < 5; n++) {
      const query = vec(q);
      withShadow.setEmbedder(async () => [query]);
      plain.setEmbedder(async () => [query]);
      expect(await withShadow.search("x")).toEqual(await plain.search("x"));
      await shadow.idle();
    }
    expect(shadow.report()).toMatchObject({ state: "ready", size: 200, queries: 5, overlapMean: 1, top1Rate: 1, skipped: 0, errors: {} });
    expect(p.rebuilds).toBe(1);
  });

  it("drapeau du profil absent : aucune comparaison, aucun démarrage du moteur", async () => {
    const p = new ExactProvider();
    const { insert, shadow, withShadow } = await setup(p);
    insert("a", 0, vec(rng(1)));
    withShadow.setEmbedder(async () => [vec(rng(2))]);
    await withShadow.search("x");
    await shadow.idle();
    expect(shadow.report()).toMatchObject({ state: "idle", queries: 0 });
    expect(p.rebuilds).toBe(0);
  });

  it("suit SQLite par ids : ré-ingestion = anciens ids retirés, nouveaux ajoutés, sans reconstruction", async () => {
    const p = new ExactProvider();
    const { db, insert, shadow, withShadow, flag } = await setup(p);
    const next = rng(7);
    for (let i = 0; i < 20; i++) insert(`d${i % 4}`, Math.floor(i / 4), vec(next));
    flag(true);
    withShadow.setEmbedder(async () => [vec(next)]);
    await withShadow.search("x");
    await shadow.idle();
    const before = db.all<{ id: number }>("SELECT id FROM rag_chunks WHERE doc_id = 'd1'").map((r) => r.id);
    db.run("DELETE FROM rag_chunks WHERE doc_id = 'd1'");
    for (let o = 0; o < 3; o++) insert("d1", o, vec(next));
    await withShadow.search("x");
    await shadow.idle();
    expect(p.rebuilds).toBe(1);
    expect(p.removed.sort()).toEqual(before.sort());
    expect([...p.rows.keys()].sort((a, b) => a - b)).toEqual(db.all<{ id: number }>("SELECT id FROM rag_chunks ORDER BY id").map((r) => r.id));
    expect(shadow.report()).toMatchObject({ size: 18, queries: 2, overlapMean: 1 });
  });

  it("une panne du moteur dégrade sans toucher la recherche servie ; indisponible = fantôme arrêté", async () => {
    const p = new ExactProvider();
    const { insert, shadow, withShadow, plain, flag } = await setup(p);
    const next = rng(3);
    for (let i = 0; i < 30; i++) insert(`d${i}`, 0, vec(next));
    flag(true);
    const query = vec(next);
    withShadow.setEmbedder(async () => [query]);
    plain.setEmbedder(async () => [query]);
    p.failWith = "timeout";
    expect(await withShadow.search("x")).toEqual(await plain.search("x"));
    await shadow.idle();
    expect(shadow.report()).toMatchObject({ state: "ready", queries: 0, errors: { timeout: 1 } });
    p.failWith = "exit";
    p.available = false;
    expect(await withShadow.search("x")).toEqual(await plain.search("x"));
    await shadow.idle();
    expect(await withShadow.search("x")).toEqual(await plain.search("x"));
    await shadow.idle();
    expect(shadow.report()).toMatchObject({ state: "degraded", errors: { timeout: 1, unavailable: 1 } });
  });
});

describe.skipIf(!existsSync(BIN))("sidecar turbovec réel (sidecars/turbovec, compilé hors ligne)", () => {
  const spec: IndexSpec = {
    indexId: "t",
    metric: "cosine",
    embedding: { model: "m", kind: "dense", dim: DIM, strategy: "symmetric", pooling: "cls", normalize: true, quantization: "f32", tokenizerSha256: null },
  };

  it("rebuild, recherche, allowlist, upsert, remove, verify, puis indisponible après close", async () => {
    const tv = new TurbovecProvider({ bin: BIN });
    const next = rng(21);
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: 1000 + i, vector: vec(next) }));
    try {
      expect(await tv.rebuild(spec, rows)).toMatchObject({ indexId: "t", size: 300 });
      const hit = await tv.search({ indexId: "t", vector: rows[42]!.vector, k: 5 });
      expect(hit).toHaveLength(5);
      expect(hit[0]!.id).toBe(1042);
      const allowed = await tv.search({ indexId: "t", vector: rows[42]!.vector, k: 5, allow: [1001, 1002, 1003] });
      expect(allowed.map((h) => h.id).every((id) => [1001, 1002, 1003].includes(id))).toBe(true);
      expect(await tv.search({ indexId: "t", vector: rows[0]!.vector, k: 5, allow: [] })).toEqual([]);
      await tv.remove("t", [1042]);
      expect((await tv.search({ indexId: "t", vector: rows[42]!.vector, k: 5 })).map((h) => h.id)).not.toContain(1042);
      await tv.upsert("t", [{ id: 1042, vector: rows[42]!.vector }]);
      expect((await tv.search({ indexId: "t", vector: rows[42]!.vector, k: 1 }))[0]!.id).toBe(1042);
      expect(await tv.verify("t")).toMatchObject({ ok: true, size: 300 });
      await expect(tv.search({ indexId: "t", vector: new Float32Array(3), k: 1 })).rejects.toMatchObject({ code: "dim" });
    } finally {
      await tv.close();
    }
    expect(tv.available).toBe(false);
  });

  it("fantôme de bout en bout : résultats servis inchangés, recouvrement élevé", async () => {
    const tv = new TurbovecProvider({ bin: BIN });
    const { insert, shadow, withShadow, plain, flag } = await setup(tv, "turbovec");
    const next = rng(9);
    const vectors = Array.from({ length: 400 }, () => vec(next));
    vectors.forEach((v, i) => insert(`d${i}`, 0, v));
    flag(true);
    try {
      for (let n = 0; n < 20; n++) {
        // Requête proche d'un chunk connu : le premier résultat est sans ambiguïté.
        const target = vectors[n * 17]!;
        const query = target.map((x) => x + (next() - 0.5) * 0.1);
        withShadow.setEmbedder(async () => [query]);
        plain.setEmbedder(async () => [query]);
        expect(await withShadow.search("x")).toEqual(await plain.search("x"));
        await shadow.idle();
      }
      const r = shadow.report();
      expect(r).toMatchObject({ state: "ready", size: 400, queries: 20, errors: {} });
      expect(r.top1Rate).toBe(1);
      expect(r.overlapMean!).toBeGreaterThan(0.5);
    } finally {
      await shadow.close();
    }
  });
});
