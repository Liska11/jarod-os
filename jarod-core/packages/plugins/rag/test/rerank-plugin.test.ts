// SPECS-P5-RERANKER.md §3 : le plugin rag lit `ctx.reranker` paresseusement (qu'il se charge avant ou après) et écrit le rapport
// fantôme dans `<profil>/rerank-shadow.jsonl` — identifiants et nombres seulement.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RerankHit, RerankRequest, RerankerProvider } from "@jarod/contracts";
import { RerankShadowEntry } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { floatsToBlob } from "../src/rag.js";

afterEach(cleanup);

const DIM = 8;
const vec = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? k * 0.1 : 0));
const fake: RerankerProvider = {
  available: true,
  maxCandidates: 32,
  info: () => ({ name: "bge-reranker-v2-m3", version: "int8-b8x512", device: "NPU" }),
  rerank: async (req: RerankRequest): Promise<RerankHit[]> => req.candidates.map((c, i) => ({ id: c.id, score: 1 - i / 100 })),
};

describe("plugin rag : reclassement", () => {
  it("fantôme : une ligne valide par recherche dans <profil>/rerank-shadow.jsonl, sans texte, profil = nom du dossier", async () => {
    const dataDir = tempDir();
    const app = await bootApp({ storage: { dataDir, keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
    // le service est fourni APRÈS le chargement du plugin rag : la lecture est paresseuse
    (app as unknown as { provide(n: string, v: unknown): void }).provide("reranker", fake);
    const { db, settings } = app.storage;
    settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 3, maxChunksPerDoc: 2 });
    settings.set("ecosystem", { ...settings.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: 5, rerankDeadlineMs: 1000 });
    for (let k = 0; k < 6; k++) {
      db.run("INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", `d${k}`, 0, `SECRET-TEXTE-${k}`, DIM, floatsToBlob(vec(k)), `h${k}`, `d${k}`, "test", 1);
    }
    app.rag.rag.setEmbedder(async () => [vec(0)]);
    await app.rag.rag.search("REQUETE-SECRETE");
    await app.rag.rag.rerankIdle();
    const file = join(dataDir, "rerank-shadow.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const e = RerankShadowEntry.parse(JSON.parse(lines[0]!));
    expect(e).toMatchObject({ outcome: "ok", mode: "shadow", engine: { device: "NPU" } });
    expect(e.profile).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(e.candidates).toHaveLength(5);
    expect(lines[0]).not.toMatch(/SECRET/);
  });

  it("sans service `reranker` ou drapeau éteint : aucun fichier, aucune erreur", async () => {
    const dataDir = tempDir();
    const app = await bootApp({ storage: { dataDir, keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
    const { db, settings } = app.storage;
    settings.set("rag", { ...settings.get("rag"), enabled: true });
    settings.set("ecosystem", { ...settings.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: 5, rerankDeadlineMs: 1000 });
    db.run("INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "d", 0, "t", DIM, floatsToBlob(vec(0)), "h", "d", "test", 1);
    app.rag.rag.setEmbedder(async () => [vec(0)]);
    expect(await app.rag.rag.search("x")).toHaveLength(1);
    expect(existsSync(join(dataDir, "rerank-shadow.jsonl"))).toBe(false);
  });
});
