// SPECS-P5-RERANKER.md §2.2 : cœur du processus dédié du reranker (`runRerankerWorker`), exercé en processus avec un faux moteur.
// Démarrage en deux temps (le modèle met ≈ 90 s à compiler sur NPU) : écoute d'abord (« listening »), « ready » seulement une fois compilé.
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runRerankerWorker } from "../src/reranker-worker-core.js";
import type { WorkerIo } from "../src/embeddings-worker-core.js";

const open: Server[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function harness(over: { init?: () => Promise<void>; scoreBatch?: (q: string, d: string[]) => Promise<number[]> } = {}) {
  const sent: Record<string, unknown>[] = [];
  let handler: (m: unknown) => void = () => {};
  const exits: number[] = [];
  const io: WorkerIo = { send: (m) => sent.push(m as Record<string, unknown>), onMessage: (cb) => (handler = cb), exit: (c) => void exits.push(c) };
  const engine = {
    batch: 4,
    available: true,
    init: over.init ?? (async () => {}),
    // score = longueur du document ; le remplissage vide vaut 0
    scoreBatch: over.scoreBatch ?? (async (_q: string, d: string[]) => d.map((x) => x.length)),
    metrics: () => ({ available: true, requested: ["NPU"], device: "NPU", attempts: [], calls: 1, candidates: 4, p50Ms: 1, p95Ms: 1, lastError: null }),
  };
  runRerankerWorker(io, { createEngine: () => engine as never });
  const until = async (pred: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  };
  return { sent, exits, send: (m: unknown) => handler(m), until };
}

const post = (port: number, body: unknown) => fetch(`http://127.0.0.1:${port}/v1/rerank`, { method: "POST", body: JSON.stringify(body) });

describe("cœur du worker reranker", () => {
  it("start : écoute sur 127.0.0.1, puis « ready » avec l'URL et l'appareil une fois le modèle compilé", async () => {
    const h = harness();
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port, batch: 4 } });
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    expect(h.sent.map((m) => m.type)).toEqual(["listening", "ready"]);
    expect(h.sent.find((m) => m.type === "ready")).toMatchObject({ url: `http://127.0.0.1:${port}/v1`, device: "NPU" });
    expect(await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()).toMatchObject({ data: [{ object: "model" }] });
    h.send({ type: "shutdown" });
    expect(h.exits).toContain(0);
  });

  it("avant la fin de la compilation : 503 RERANKER_WARMING, jamais un résultat vide ni une attente de 90 s", async () => {
    let finish: () => void = () => {};
    const h = harness({ init: () => new Promise<void>((r) => (finish = r)) });
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port, batch: 4 } });
    await h.until(() => h.sent.some((m) => m.type === "listening"));
    const r = await post(port, { query: "q", documents: ["a"] });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("RERANKER_WARMING");
    expect(h.sent.some((m) => m.type === "ready")).toBe(false);
    finish();
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    expect((await post(port, { query: "q", documents: ["a"] })).status).toBe(200);
  });

  it("/v1/rerank : résultats triés par score décroissant, indices d'entrée, remplissage jamais rendu, plus de candidats que le lot", async () => {
    const h = harness();
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port, batch: 4 } });
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    const docs = ["aa", "bbbbbb", "c", "dddd", "eeeeeeeee", "ff"]; // 6 > lot de 4
    const r = await post(port, { query: "q", documents: docs });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { results: { index: number; relevance_score: number }[] };
    expect(body.results.map((x) => x.index)).toEqual([4, 1, 3, 0, 5, 2]); // 9, 6, 4, 2, 2 (égalité : ordre d'entrée), 1
    expect(body.results).toHaveLength(6);
    h.send({ type: "shutdown" });
  });

  it("requête invalide : 400 ; mauvaise route : 404 ; corps trop gros : 413", async () => {
    const h = harness();
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port, batch: 4 } });
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    expect((await post(port, { query: 3, documents: ["a"] })).status).toBe(400);
    expect((await post(port, { query: "q", documents: "a" })).status).toBe(400);
    expect((await post(port, { query: "q", documents: [1] })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/v1/autre`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await post(port, { query: "q", documents: Array(200).fill("x") })).status).toBe(400); // plafond de candidats
    h.send({ type: "shutdown" });
  });

  it("erreur du moteur pendant une requête : 500 avec un code, sans texte de document, le worker reste vivant", async () => {
    const h = harness({ scoreBatch: async () => { throw Object.assign(new Error("RERANKER_FAILED : boom"), { code: "RERANKER_FAILED" }); } });
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port, batch: 4 } });
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    const r = await post(port, { query: "SECRET-Q", documents: ["SECRET-D"] });
    expect(r.status).toBe(500);
    expect(JSON.stringify(h.sent)).not.toContain("SECRET");
    expect(h.exits).toEqual([]);
    h.send({ type: "shutdown" });
  });

  it("port occupé : RERANKER_PORT_BUSY franc, sortie en code 1, aucun repli sur un autre port", async () => {
    const h = harness();
    const port = await freePort();
    const squatter = createServer();
    open.push(squatter);
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", () => r()));
    h.send({ type: "start", config: { modelDir: "/m", port, batch: 4 } });
    await h.until(() => h.exits.length > 0);
    expect(h.sent.find((m) => m.type === "error")).toMatchObject({ code: "RERANKER_PORT_BUSY" });
    expect(h.exits).toEqual([1]);
    expect(h.sent.some((m) => m.type === "ready")).toBe(false);
  });

  it("aucun appareil : RERANKER_NO_DEVICE, sortie en code 1", async () => {
    const h = harness({ init: async () => { throw Object.assign(new Error("RERANKER_NO_DEVICE : aucun périphérique"), { code: "RERANKER_NO_DEVICE" }); } });
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port, batch: 4 } });
    await h.until(() => h.exits.length > 0);
    expect(h.sent.find((m) => m.type === "error")).toMatchObject({ code: "RERANKER_NO_DEVICE" });
    expect(h.exits).toEqual([1]);
  });

  it("configuration invalide : RERANKER_BAD_CONFIG, sortie en code 1", async () => {
    for (const config of [undefined, {}, { modelDir: "/m" }, { modelDir: "/m", port: 0 }, { modelDir: "", port: 8930 }, { modelDir: "/m", port: 8930, batch: 0 }]) {
      const h = harness();
      h.send({ type: "start", config });
      await h.until(() => h.exits.length > 0);
      expect(h.sent.find((m) => m.type === "error"), JSON.stringify(config)).toMatchObject({ code: "RERANKER_BAD_CONFIG" });
      expect(h.exits).toEqual([1]);
    }
  });
});
