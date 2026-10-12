// SPECS-P5-RERANKER.md §3, §6 : le reclassement dans `RagService.search` — éteint = octet pour octet la pile d'avant ; fantôme = calculé et
// journalisé (identifiants seulement), JAMAIS servi, sans attente ; actif = servi, avec repli sur l'ordre d'origine (échéance, panne,
// worker pas prêt). Faux `RerankerProvider`, aucun OpenVINO.
import type { EngineInfo, RerankHit, RerankRequest, RerankShadowEntry, RerankerProvider } from "@jarod/contracts";
import { RerankShadowEntry as EntrySchema } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { floatsToBlob, RagService } from "../src/rag.js";

afterEach(cleanup);

const DIM = 16;
/** Vecteur dont le cosinus avec `unit(0)` décroît avec `k` : l'ordre du dense est celui de `k` croissant. */
const vec = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? k * 0.1 : 0));
const QUERY = vec(0);

class FakeReranker implements RerankerProvider {
  available = true;
  readonly maxCandidates: number;
  calls: RerankRequest[] = [];
  /** Ordre rendu : indices (positions dans `candidates`) ; défaut = inversé. */
  order: ((n: number) => number[]) | null = null;
  delayMs = 0;
  failWith: string | null = null;
  constructor(maxCandidates = 32) {
    this.maxCandidates = maxCandidates;
  }
  info(): EngineInfo {
    return { name: "bge-reranker-v2-m3", version: "int8-b8x512", device: "NPU" };
  }
  async rerank(req: RerankRequest): Promise<RerankHit[]> {
    this.calls.push(req);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw Object.assign(new Error(this.failWith), { code: this.failWith });
    const n = req.candidates.length;
    const idx = this.order ? this.order(n) : Array.from({ length: n }, (_, i) => n - 1 - i);
    return idx.slice(0, req.topN).map((i, rank) => ({ id: req.candidates[i]!.id, score: 1 - rank / 100 }));
  }
}

async function setup(o: { fake?: FakeReranker; flags?: Record<string, unknown>; docs?: number; perDoc?: number } = {}) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 4, maxChunksPerDoc: o.perDoc ?? 2 });
  settings.set("ecosystem", { ...settings.get("ecosystem"), ...(o.flags ?? {}) });
  const n = o.docs ?? 12;
  for (let k = 0; k < n; k++) {
    db.run(
      "INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      `doc${k}`,
      0,
      `SECRET-TEXTE-${k}`,
      DIM,
      floatsToBlob(vec(k)),
      `h${k}`,
      `doc${k}`,
      "test",
      1,
    );
  }
  const entries: RerankShadowEntry[] = [];
  const base = { db, settings, providers: { def: () => ({ local: true }) as never } };
  const plain = new RagService(base);
  const withRr = new RagService({ ...base, ...(o.fake ? { reranker: () => o.fake } : {}), rerankReport: (e) => entries.push(e), profile: "default" });
  for (const s of [plain, withRr]) s.setEmbedder(async () => [QUERY]);
  return { db, settings, plain, withRr, entries, setFlags: (f: Record<string, unknown>) => settings.set("ecosystem", { ...settings.get("ecosystem"), ...f }) };
}

const ON = { reranker: "bge-reranker-v2-m3-npu", rerankTopN: 8, rerankDeadlineMs: 2000 };
const ids = (hits: { docId: string }[]) => hits.map((h) => h.docId);

describe("reclassement dans RagService.search", () => {
  it("drapeau éteint (défaut) : le reranker n'est jamais appelé, résultats identiques à la pile d'avant", async () => {
    const fake = new FakeReranker();
    const { plain, withRr, entries } = await setup({ fake });
    expect(await withRr.search("x")).toEqual(await plain.search("x"));
    expect(fake.calls).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("allumé mais SANS budget (rerankTopN ou rerankDeadlineMs absent) : traité comme éteint (aucun seuil sans décision)", async () => {
    for (const flags of [{ reranker: "bge-reranker-v2-m3-npu", rerankDeadlineMs: 1000 }, { reranker: "bge-reranker-v2-m3-npu", rerankTopN: 8 }]) {
      const fake = new FakeReranker();
      const { plain, withRr } = await setup({ fake, flags });
      expect(await withRr.search("x")).toEqual(await plain.search("x"));
      expect(fake.calls).toHaveLength(0);
    }
  });

  it("fantôme (défaut de rerankMode) : résultats servis INCHANGÉS, le reranker voit les N premiers, le journal reçoit le classement", async () => {
    const fake = new FakeReranker();
    const { plain, withRr, entries } = await setup({ fake, flags: ON });
    const served = await withRr.search("x");
    expect(served).toEqual(await plain.search("x"));
    await withRr.rerankIdle();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.candidates).toHaveLength(8);
    expect(fake.calls[0]!.topN).toBe(8);
    expect(fake.calls[0]!.deadlineMs).toBe(2000);
    expect(entries).toHaveLength(1);
    const e = EntrySchema.parse(entries[0]);
    expect(e).toMatchObject({ outcome: "ok", mode: "shadow", profile: "default", engine: { name: "bge-reranker-v2-m3", device: "NPU" } });
    expect(e.candidates).toHaveLength(8);
    expect(e.reranked).toEqual([...e.candidates].reverse());
  });

  it("fantôme : la recherche ne dépend PAS de la durée du reranker (rendue avant la fin du calcul)", async () => {
    const fake = new FakeReranker();
    fake.delayMs = 400;
    const { withRr, entries } = await setup({ fake, flags: ON });
    const t0 = Date.now();
    await withRr.search("x");
    expect(Date.now() - t0).toBeLessThan(250);
    expect(entries).toHaveLength(0);
    await withRr.rerankIdle();
    expect(entries).toHaveLength(1);
  });

  it("fantôme : une panne ou une échéance du reranker ne touche ni les résultats ni n'émet de rejet non géré", async () => {
    const fake = new FakeReranker();
    fake.failWith = "RERANKER_TIMEOUT";
    const { plain, withRr, entries } = await setup({ fake, flags: ON });
    expect(await withRr.search("x")).toEqual(await plain.search("x"));
    await withRr.rerankIdle();
    expect(entries[0]).toMatchObject({ outcome: "timeout", reason: "RERANKER_TIMEOUT", mode: "shadow", reranked: [] });
    expect(EntrySchema.safeParse(entries[0]).success).toBe(true);
  });

  it("fantôme : worker pas prêt (compilation) = aucun appel, aucune entrée (pas de bruit pendant les 90 s)", async () => {
    const fake = new FakeReranker();
    fake.available = false;
    const { plain, withRr, entries } = await setup({ fake, flags: ON });
    expect(await withRr.search("x")).toEqual(await plain.search("x"));
    await withRr.rerankIdle();
    expect(fake.calls).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("actif : l'ordre du reranker est SERVI sur les N candidats, limité à k ; l'entrée est en mode « active »", async () => {
    const fake = new FakeReranker();
    const { plain, withRr, entries } = await setup({ fake, flags: { ...ON, rerankMode: "active" } });
    const base = ids(await plain.search("x"));
    const served = ids(await withRr.search("x"));
    expect(base).toEqual(["doc0", "doc1", "doc2", "doc3"]);
    expect(served).toEqual(["doc7", "doc6", "doc5", "doc4"]); // inversé parmi les 8 candidats, 4 rendus
    expect(entries[0]).toMatchObject({ outcome: "ok", mode: "active" });
  });

  it("actif : k plus grand que N — les résultats au-delà des N candidats suivent, dans leur ordre d'origine", async () => {
    const fake = new FakeReranker();
    const { withRr } = await setup({ fake, flags: { ...ON, rerankMode: "active", rerankTopN: 4 } });
    const served = ids(await withRr.search("x", 6));
    expect(served).toEqual(["doc3", "doc2", "doc1", "doc0", "doc4", "doc5"]);
  });

  it("actif : échéance, panne, occupé → ordre d'origine (repli du contrat, jamais une erreur pour l'utilisateur)", async () => {
    for (const code of ["RERANKER_TIMEOUT", "RERANKER_BUSY", "RERANKER_UNAVAILABLE", "RERANKER_FAILED"]) {
      const fake = new FakeReranker();
      fake.failWith = code;
      const { plain, withRr, entries } = await setup({ fake, flags: { ...ON, rerankMode: "active" } });
      expect(await withRr.search("x")).toEqual(await plain.search("x"));
      expect(entries[0], code).toMatchObject({ mode: "active", reason: code, reranked: [] });
    }
  });

  it("actif : un classement qui oublie des candidats ne perd AUCUN résultat (les manquants suivent dans l'ordre d'origine)", async () => {
    const fake = new FakeReranker();
    fake.order = () => [3, 1]; // deux seulement
    const { withRr } = await setup({ fake, flags: { ...ON, rerankMode: "active", rerankTopN: 5 } });
    expect(ids(await withRr.search("x"))).toEqual(["doc3", "doc1", "doc0", "doc2"]);
  });

  it("N est borné par maxCandidates du reranker ; les candidats respectent le plafond par document", async () => {
    const fake = new FakeReranker(3);
    const { withRr } = await setup({ fake, flags: { ...ON, rerankTopN: 16 } });
    await withRr.search("x");
    await withRr.rerankIdle();
    expect(fake.calls[0]!.candidates).toHaveLength(3);
  });

  it("aucun texte (requête ni passage) dans les entrées du journal", async () => {
    const fake = new FakeReranker();
    const { withRr, entries } = await setup({ fake, flags: ON });
    await withRr.search("REQUETE-SECRETE");
    await withRr.rerankIdle();
    expect(JSON.stringify(entries)).not.toMatch(/SECRET/);
  });

  it("l'entrée porte les identifiants rag_chunks.id (numériques, stables)", async () => {
    const fake = new FakeReranker();
    const { db, withRr, entries } = await setup({ fake, flags: ON });
    await withRr.search("x");
    await withRr.rerankIdle();
    const known = new Set(db.all<{ id: number }>("SELECT id FROM rag_chunks").map((r) => r.id));
    for (const id of entries[0]!.candidates) expect(known.has(id)).toBe(true);
  });
});
