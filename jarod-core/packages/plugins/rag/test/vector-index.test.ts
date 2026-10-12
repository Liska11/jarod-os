// G2 : l'index en mémoire rend EXACTEMENT ce que rendait le balayage complet, et suit les écritures.
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { floatsToBlob, RagService } from "../src/rag.js";

afterEach(cleanup);

const DIM = 64;
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

async function setup() {
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
      "m",
      1,
    );
  // Balayage d'origine sur la même base : la référence.
  const scan = new RagService({ db, settings, providers: { def: () => ({ local: true }) as never } });
  return { app, db, insert, indexed: app.rag.rag, scan };
}

describe("VectorIndex", () => {
  it("rend les mêmes résultats que le balayage complet (scores et ordre)", async () => {
    const { insert, indexed, scan } = await setup();
    const next = rng(3);
    for (let i = 0; i < 300; i++) insert(`d${i % 40}`, Math.floor(i / 40), vec(next));
    const q = rng(9);
    for (let n = 0; n < 10; n++) {
      const query = vec(q);
      indexed.setEmbedder(async () => [query]);
      scan.setEmbedder(async () => [query]);
      expect(await indexed.search("x")).toEqual(await scan.search("x"));
    }
  });

  it("voit une écriture faite hors de RagService (autre processus sur la même base)", async () => {
    const { insert, indexed } = await setup();
    const next = rng(5);
    insert("a", 0, vec(next));
    const target = vec(next);
    indexed.setEmbedder(async () => [target]);
    expect((await indexed.search("x")).map((h) => h.docId)).toEqual(["a"]);
    insert("b", 0, target);
    expect((await indexed.search("x"))[0]).toMatchObject({ docId: "b", score: expect.closeTo(1, 6) });
  });

  it("dimension différente : la même erreur explicite que le balayage", async () => {
    const { insert, indexed } = await setup();
    insert("a", 0, vec(rng(1)));
    indexed.setEmbedder(async () => [new Float32Array(DIM + 1)]);
    await expect(indexed.search("x")).rejects.toThrow(/RAG_DIM_MISMATCH/);
  });
});
