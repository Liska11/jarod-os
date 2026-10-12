// SPECS-P5-RERANKER.md §2 : `RerankerService` respecte le contrat `RerankerProvider` de @jarod/contracts (candidats DÉJÀ fusionnés,
// topN, échéance, jamais d'attente d'un modèle qui compile), au-dessus d'un hôte quelconque (faux ici).
import type { RerankerProvider } from "@jarod/contracts";
import type { VoicePriority } from "@jarod/contracts";
import { describe, expect, it } from "vitest";
import { type RerankHost, RerankerService } from "../src/reranker-service.js";

function fakeHost(over: Partial<RerankHost> = {}) {
  const calls: { query: string; docs: readonly string[]; deadlineMs: number }[] = [];
  const host: RerankHost = {
    available: true,
    metrics: () => ({ available: true, requested: ["NPU"], device: "NPU", attempts: [], calls: 0, candidates: 0, p50Ms: null, p95Ms: null, lastError: null }),
    // score = longueur du texte ; trié décroissant, indices d'entrée
    rerank: async (query, docs, deadlineMs) => {
      calls.push({ query, docs, deadlineMs });
      return docs.map((d, index) => ({ index, score: d.length })).sort((a, b) => b.score - a.score || a.index - b.index);
    },
    ...over,
  };
  return { host, calls };
}
const cands = (...texts: string[]) => texts.map((text, i) => ({ id: 100 + i, text }));

describe("RerankerService", () => {
  it("rend des RerankHit { id, score } dans l'ordre du reranker, limités à topN, avec les identifiants d'origine", async () => {
    const { host, calls } = fakeHost();
    const svc: RerankerProvider = new RerankerService(host, { batch: 8, maxLength: 512 });
    const hits = await svc.rerank({ query: "q", candidates: cands("aa", "bbbbb", "c", "dddd"), topN: 2, deadlineMs: 1500 });
    expect(hits).toEqual([{ id: 101, score: 5 }, { id: 103, score: 4 }]);
    expect(calls).toEqual([{ query: "q", docs: ["aa", "bbbbb", "c", "dddd"], deadlineMs: 1500 }]);
  });

  it("aucun candidat : [] sans appeler l'hôte", async () => {
    const { host, calls } = fakeHost();
    expect(await new RerankerService(host, { batch: 8, maxLength: 512 }).rerank({ query: "q", candidates: [], topN: 5, deadlineMs: 100 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("plus de candidats que maxCandidates : RERANKER_TOO_MANY (l'appelant borne), sans appeler l'hôte", async () => {
    const { host, calls } = fakeHost();
    const svc = new RerankerService(host, { batch: 8, maxLength: 512 });
    expect(svc.maxCandidates).toBe(32);
    await expect(svc.rerank({ query: "q", candidates: cands(...Array(33).fill("x")), topN: 5, deadlineMs: 100 })).rejects.toMatchObject({ code: "RERANKER_TOO_MANY" });
    expect(calls).toHaveLength(0);
  });

  it("hôte absent (service inactif) ou pas prêt : available faux, rerank échoue tout de suite avec un code", async () => {
    const inactive = new RerankerService(null, { batch: 8, maxLength: 512 }, "reranker.json absent");
    expect(inactive.available).toBe(false);
    await expect(inactive.rerank({ query: "q", candidates: cands("a"), topN: 1, deadlineMs: 100 })).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
    const { host } = fakeHost({ available: false, rerank: async () => { throw Object.assign(new Error("x"), { code: "RERANKER_UNAVAILABLE" }); } });
    const svc = new RerankerService(host, { batch: 8, maxLength: 512 });
    expect(svc.available).toBe(false);
    await expect(svc.rerank({ query: "q", candidates: cands("a"), topN: 1, deadlineMs: 100 })).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
  });

  it("signal déjà annulé : refus avant tout appel", async () => {
    const { host, calls } = fakeHost();
    const ac = new AbortController();
    ac.abort();
    await expect(new RerankerService(host, { batch: 8, maxLength: 512 }).rerank({ query: "q", candidates: cands("a"), topN: 1, deadlineMs: 100, signal: ac.signal })).rejects.toMatchObject({ code: "RERANKER_ABORTED" });
    expect(calls).toHaveLength(0);
  });

  it("info() : moteur, version de l'IR (lot × longueur) et appareil EFFECTIF ; sans appareil, pas de champ device", () => {
    const { host } = fakeHost();
    expect(new RerankerService(host, { batch: 8, maxLength: 512 }).info()).toEqual({ name: "bge-reranker-v2-m3", version: "int8-b8x512", device: "NPU" });
    const none = fakeHost({ metrics: () => ({ available: false, requested: [], device: null, attempts: [], calls: 0, candidates: 0, p50Ms: null, p95Ms: null, lastError: null }) });
    expect(new RerankerService(none.host, { batch: 8, maxLength: 512 }).info()).toEqual({ name: "bge-reranker-v2-m3", version: "int8-b8x512" });
  });
});

// SPECS-P5-RERANKER-PAUSE.md §2 : tant que la voix est active, aucun reclassement ne démarre (rejet immédiat RERANKER_PAUSED, l'appelant
// garde l'ordre d'origine) ; défaillance de la lecture de la priorité = pas de pause (fail-open) ; voicePriority:false = témoin du banc.
function fakeVoice(active = false): VoicePriority & { active: boolean } {
  return { active, whenIdle: async () => {} };
}

describe("RerankerService — la voix est prioritaire", () => {
  const req = { query: "q", candidates: cands("a", "bb"), topN: 2, deadlineMs: 100 };

  it("voix active : RERANKER_PAUSED tout de suite, l'hôte n'est jamais appelé, le compteur monte ; voix inactive : le reclassement passe", async () => {
    const { host, calls } = fakeHost();
    const voice = fakeVoice(true);
    const svc = new RerankerService(host, { batch: 8, maxLength: 512 }, null, { voice: () => voice });
    await expect(svc.rerank(req)).rejects.toMatchObject({ code: "RERANKER_PAUSED" });
    await expect(svc.rerank(req)).rejects.toMatchObject({ code: "RERANKER_PAUSED" });
    expect(calls).toHaveLength(0);
    expect(svc.pausedCount).toBe(2);
    voice.active = false;
    expect(await svc.rerank(req)).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(svc.pausedCount).toBe(2);
  });

  it("la priorité est lue à CHAQUE appel (paresseusement) : absente puis apparue", async () => {
    const { host } = fakeHost();
    let voice: VoicePriority | undefined;
    const svc = new RerankerService(host, { batch: 8, maxLength: 512 }, null, { voice: () => voice });
    expect(await svc.rerank(req)).toHaveLength(2);
    voice = fakeVoice(true);
    await expect(svc.rerank(req)).rejects.toMatchObject({ code: "RERANKER_PAUSED" });
  });

  it("priorité qui lève : pas de pause (fail-open), le reclassement passe et l'erreur est journalisée", async () => {
    const { host } = fakeHost();
    const logs: string[] = [];
    const svc = new RerankerService(host, { batch: 8, maxLength: 512 }, null, { voice: () => { throw new Error("boum"); }, log: (l) => logs.push(l) });
    expect(await svc.rerank(req)).toHaveLength(2);
    expect(logs.join(" | ")).toMatch(/boum/);
  });

  it("voicePriority:false (condition TÉMOIN du banc) : aucune pause même voix active", async () => {
    const { host, calls } = fakeHost();
    const svc = new RerankerService(host, { batch: 8, maxLength: 512 }, null, { voice: () => fakeVoice(true), voicePriority: false });
    expect(await svc.rerank(req)).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(svc.pausedCount).toBe(0);
  });

  it("sans candidat ou service inactif : le code d'origine prime sur la pause pour un service inactif, [] pour une liste vide sans pause comptée", async () => {
    const inactive = new RerankerService(null, { batch: 8, maxLength: 512 }, "reranker.json absent", { voice: () => fakeVoice(true) });
    await expect(inactive.rerank(req)).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
    const { host } = fakeHost();
    const svc = new RerankerService(host, { batch: 8, maxLength: 512 }, null, { voice: () => fakeVoice(true) });
    expect(await svc.rerank({ ...req, candidates: [] })).toEqual([]);
    expect(svc.pausedCount).toBe(0);
  });
});
