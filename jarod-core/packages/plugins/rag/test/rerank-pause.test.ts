// SPECS-P5-RERANKER-PAUSE.md §2 : pendant la dictée le service refuse (RERANKER_PAUSED). Mode actif : ordre d'origine tout de suite, issue
// « paused », rien n'est rejoué. Mode fantôme : l'entrée « paused » est écrite, le reclassement est différé (file bornée, péremption) et
// rejoué à la fin de la dictée dans l'ordre d'arrivée. Aucun texte dans le rapport. Faux reranker et fausse voix, aucun OpenVINO.
import type { EngineInfo, RerankHit, RerankRequest, RerankShadowEntry, RerankerProvider, VoicePriority } from "@jarod/contracts";
import { RerankShadowEntry as EntrySchema } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { floatsToBlob, RagService } from "../src/rag.js";

afterEach(cleanup);

const DIM = 16;
const vec = (k: number) => Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? k * 0.1 : 0));
const QUERY = vec(0);

class FakeReranker implements RerankerProvider {
  available = true;
  readonly maxCandidates = 32;
  paused = false;
  /** Pause dérivée de l'état de la voix (comme le vrai service) ; s'ajoute à `paused`. */
  linked: (() => boolean) | null = null;
  calls: RerankRequest[] = [];
  info(): EngineInfo {
    return { name: "bge-reranker-v2-m3", version: "int8-b8x512", device: "NPU" };
  }
  async rerank(req: RerankRequest): Promise<RerankHit[]> {
    if (this.paused || this.linked?.()) throw Object.assign(new Error("RERANKER_PAUSED"), { code: "RERANKER_PAUSED" });
    this.calls.push(req);
    const n = req.candidates.length;
    return Array.from({ length: n }, (_, i) => n - 1 - i).slice(0, req.topN).map((i, rank) => ({ id: req.candidates[i]!.id, score: 1 - rank / 100 }));
  }
}

/** Voix pilotable : `busy()` l'ouvre, `free()` la ferme et réveille les `whenIdle` en attente. */
function fakeVoice() {
  let active = false;
  const waiters: (() => void)[] = [];
  const api: VoicePriority = {
    get active() {
      return active;
    },
    whenIdle: () => (active ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
  };
  return {
    api,
    busy: () => void (active = true),
    free: () => {
      active = false;
      for (const w of waiters.splice(0)) w();
    },
  };
}

async function setup(o: { mode: "shadow" | "active"; voice?: ReturnType<typeof fakeVoice> | null; deferral?: { max?: number; staleMs?: number } }) {
  const app = await bootApp({ storage: { dataDir: tempDir(), keyStores: [memoryKeyStore()] }, llm: {}, rag: {} });
  const { db, settings } = app.storage;
  settings.set("rag", { ...settings.get("rag"), enabled: true, topK: 4, maxChunksPerDoc: 2 });
  settings.set("ecosystem", { ...settings.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: 8, rerankDeadlineMs: 2000, rerankMode: o.mode });
  for (let k = 0; k < 12; k++) {
    db.run("INSERT INTO rag_chunks (doc_id, ord, text, dim, embedding, sha256, source, model, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", `doc${k}`, 0, `SECRET-TEXTE-${k}`, DIM, floatsToBlob(vec(k)), `h${k}`, `doc${k}`, "test", 1);
  }
  const fake = new FakeReranker();
  const entries: RerankShadowEntry[] = [];
  const logs: string[] = [];
  const base = { db, settings, providers: { def: () => ({ local: true }) as never } };
  const plain = new RagService(base);
  const voice = o.voice === undefined ? fakeVoice() : o.voice;
  const svc = new RagService({
    ...base,
    reranker: () => fake,
    rerankReport: (e) => entries.push(e),
    profile: "default",
    log: (l) => logs.push(l),
    ...(voice ? { voice: () => voice.api } : {}),
    ...(o.deferral ? { rerankDeferral: o.deferral } : {}),
  });
  for (const s of [plain, svc]) s.setEmbedder(async () => [QUERY]);
  return { plain, svc, fake, voice, entries, logs };
}
const ids = (hits: { docId: string }[]) => hits.map((h) => h.docId);

describe("reclassement et voix — mode actif", () => {
  it("dictée en cours : ordre d'origine SERVI sans attente, issue « paused » au rapport, rien n'est rejoué", async () => {
    const { plain, svc, fake, voice, entries } = await setup({ mode: "active" });
    voice!.busy();
    fake.paused = true;
    const t0 = Date.now();
    const hits = await svc.search("x");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ids(hits)).toEqual(ids(await plain.search("x")));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "paused", mode: "active", reason: "RERANKER_PAUSED", reranked: [] });
    expect(entries[0]!.candidates.length).toBeGreaterThan(0);
    fake.paused = false;
    voice!.free();
    await svc.rerankIdle();
    expect(fake.calls).toHaveLength(0);
    expect(entries).toHaveLength(1);
  });
});

describe("reclassement et voix — mode fantôme", () => {
  it("dictée en cours : résultats inchangés, entrée « paused » tout de suite ; à la fin de la dictée le reclassement est REJOUÉ (entrée « ok », mode fantôme)", async () => {
    const { plain, svc, fake, voice, entries } = await setup({ mode: "shadow" });
    voice!.busy();
    fake.paused = true;
    expect(ids(await svc.search("x"))).toEqual(ids(await plain.search("x")));
    expect(entries.map((e) => e.outcome)).toEqual(["paused"]);
    expect(fake.calls).toHaveLength(0);
    fake.paused = false;
    voice!.free();
    await svc.rerankIdle();
    expect(fake.calls).toHaveLength(1);
    expect(entries.map((e) => [e.outcome, e.mode])).toEqual([["paused", "shadow"], ["ok", "shadow"]]);
    expect(entries[1]!.reranked.length).toBe(entries[1]!.candidates.length);
    expect(svc.rerankDeferrals()).toEqual({ deferred: 1, replayed: 1, stale: 0 });
  });

  it("plusieurs recherches pendant la dictée : rejouées dans l'ordre d'arrivée", async () => {
    const { svc, fake, voice } = await setup({ mode: "shadow" });
    voice!.busy();
    fake.paused = true;
    await svc.search("première");
    await svc.search("deuxième");
    await svc.search("troisième");
    fake.paused = false;
    voice!.free();
    await svc.rerankIdle();
    expect(fake.calls.map((c) => c.query)).toEqual(["première", "deuxième", "troisième"]);
  });

  it("file bornée : au-delà de la limite le plus ancien est abandonné (« stale », file pleine), les autres sont rejoués", async () => {
    const { svc, fake, voice, entries } = await setup({ mode: "shadow", deferral: { max: 3 } });
    voice!.busy();
    fake.paused = true;
    for (const q of ["a", "b", "c", "d", "e"]) await svc.search(q);
    fake.paused = false;
    voice!.free();
    await svc.rerankIdle();
    expect(fake.calls.map((c) => c.query)).toEqual(["c", "d", "e"]);
    const stale = entries.filter((e) => e.outcome === "stale");
    expect(stale).toHaveLength(2);
    expect(stale.every((e) => e.reason === "queue-full")).toBe(true);
    expect(svc.rerankDeferrals()).toEqual({ deferred: 5, replayed: 3, stale: 2 });
  });

  it("péremption : un reclassement plus vieux que le délai à la reprise est abandonné (« stale », trop vieux), sans appel", async () => {
    const { svc, fake, voice, entries } = await setup({ mode: "shadow", deferral: { staleMs: 40 } });
    voice!.busy();
    fake.paused = true;
    await svc.search("x");
    await new Promise((r) => setTimeout(r, 120));
    fake.paused = false;
    voice!.free();
    await svc.rerankIdle();
    expect(fake.calls).toHaveLength(0);
    expect(entries.map((e) => [e.outcome, e.reason])).toEqual([["paused", "RERANKER_PAUSED"], ["stale", "too-old"]]);
  });

  it("la voix se rouvre juste au moment du rejeu : le reclassement revient en tête de file et n'est rejoué qu'à la fin de la seconde dictée, une seule fois", async () => {
    const { svc, fake, voice, entries } = await setup({ mode: "shadow" });
    fake.linked = () => voice!.api.active; // le service refuse exactement quand la voix est active
    voice!.busy();
    await svc.search("x");
    voice!.free();
    voice!.busy(); // la seconde dictée s'ouvre avant que le rejeu ne parte
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.calls).toHaveLength(0);
    voice!.free();
    await svc.rerankIdle();
    expect(fake.calls).toHaveLength(1);
    expect(entries.filter((e) => e.outcome === "ok")).toHaveLength(1);
    expect(entries.filter((e) => e.outcome === "paused")).toHaveLength(1); // pas de doublon « paused » au rejeu
  });

  it("incohérence (le service refuse alors que la voix est libre) : abandon « stale » (toujours en pause), jamais de boucle serrée", async () => {
    const { svc, fake, voice, entries } = await setup({ mode: "shadow" });
    voice!.busy();
    fake.paused = true;
    await svc.search("x");
    voice!.free(); // fake.paused reste vrai
    await svc.rerankIdle();
    expect(entries.map((e) => [e.outcome, e.reason])).toEqual([["paused", "RERANKER_PAUSED"], ["stale", "still-paused"]]);
  });

  it("sans fournisseur de voix (rien ne dira quand reprendre) : abandon « stale » (pas de voix), jamais de rejeu à l'aveugle", async () => {
    const { svc, fake, entries } = await setup({ mode: "shadow", voice: null });
    fake.paused = true;
    await svc.search("x");
    await svc.rerankIdle();
    expect(fake.calls).toHaveLength(0);
    expect(entries.map((e) => [e.outcome, e.reason])).toEqual([["paused", "RERANKER_PAUSED"], ["stale", "no-voice"]]);
  });

  it("aucun texte (requête ni passage) dans les entrées, toutes valides pour le schéma du rapport", async () => {
    const { svc, fake, voice, entries } = await setup({ mode: "shadow", deferral: { max: 1 } });
    voice!.busy();
    fake.paused = true;
    await svc.search("question secrète A");
    await svc.search("question secrète B");
    fake.paused = false;
    voice!.free();
    await svc.rerankIdle();
    const json = JSON.stringify(entries);
    expect(json).not.toMatch(/SECRET|secrète|question/);
    for (const e of entries) expect(EntrySchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  });

  it("une recherche pendant la dictée ne dépend jamais de la file (durée courte même file pleine)", async () => {
    const { svc, fake, voice } = await setup({ mode: "shadow", deferral: { max: 2 } });
    voice!.busy();
    fake.paused = true;
    const t0 = Date.now();
    for (let i = 0; i < 6; i++) await svc.search(`q${i}`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
