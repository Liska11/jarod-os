// SPECS-P5-EMBEDDINGS.md §3.2, §10.1 : cœur du processus dédié (`runEmbeddingsWorker`), exercé en processus avec un faux moteur.
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runEmbeddingsWorker, type WorkerIo } from "../src/embeddings-worker-core.js";

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

function harness() {
  const sent: Record<string, unknown>[] = [];
  let handler: (m: unknown) => void = () => {};
  const exits: number[] = [];
  const io: WorkerIo = { send: (m) => sent.push(m as Record<string, unknown>), onMessage: (cb) => (handler = cb), exit: (c) => void exits.push(c) };
  const engine = {
    available: true,
    embed: async (t: string[]) => t.map((x) => Float32Array.from([x.length, 1, 0, 0])),
    tokens: async (t: string) => t.length,
    warmup: async () => {},
    metrics: () => ({ available: true, requested: ["NPU"], device: { 128: "NPU" }, attempts: [], calls: 1, texts: 1, p50Ms: 1, p95Ms: 1, lastError: null }) as never,
  };
  runEmbeddingsWorker(io, { createEngine: () => engine as never });
  const until = async (pred: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  };
  return { sent, exits, send: (m: unknown) => handler(m), until };
}

describe("cœur du worker d'embeddings", () => {
  it("start : écoute sur 127.0.0.1 au port demandé, annonce « ready » avec l'URL, sert /v1/models et /v1/embeddings", async () => {
    const h = harness();
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port } });
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    expect(h.sent.find((m) => m.type === "ready")).toEqual({ type: "ready", url: `http://127.0.0.1:${port}/v1` });
    expect(await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()).toMatchObject({ data: [{ object: "model" }] });
    const r = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, { method: "POST", body: JSON.stringify({ input: ["abc"] }) });
    expect((await r.json()) as { data: { embedding: number[] }[] }).toMatchObject({ data: [{ embedding: [3, 1, 0, 0] }] });
    await h.until(() => h.sent.some((m) => m.type === "metrics"));
    expect(h.sent.find((m) => m.type === "metrics")).toMatchObject({ metrics: { device: { 128: "NPU" } } });
    h.send({ type: "shutdown" });
    await h.until(() => h.exits.length > 0);
    expect(h.exits).toEqual([0]);
  });

  it("aucune interface autre que le bouclage : une connexion vers une autre adresse locale est refusée", async () => {
    const h = harness();
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port } });
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    const other = (await import("node:os")).networkInterfaces();
    const external = Object.values(other).flat().find((i) => i && !i.internal && i.family === "IPv4");
    if (external) await expect(fetch(`http://${external.address}:${port}/v1/models`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    h.send({ type: "shutdown" });
  });

  it("port occupé : EMBEDDINGS_PORT_BUSY, sortie en code 1, jamais d'écoute ailleurs", async () => {
    const h = harness();
    const port = await freePort();
    const blocker = createServer();
    open.push(blocker);
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", r));
    h.send({ type: "start", config: { modelDir: "/m", port } });
    await h.until(() => h.exits.length > 0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: "error", code: "EMBEDDINGS_PORT_BUSY" });
    expect(String(h.sent[0]!.message)).toContain(String(port));
    expect(h.exits).toEqual([1]);
  });

  it("configuration invalide : EMBEDDINGS_BAD_CONFIG et sortie en code 1", async () => {
    for (const config of [{}, { modelDir: "/m" }, { modelDir: "/m", port: 0 }, { modelDir: "/m", port: "8920" }]) {
      const h = harness();
      h.send({ type: "start", config });
      await h.until(() => h.exits.length > 0);
      expect(h.sent[0]).toMatchObject({ type: "error", code: "EMBEDDINGS_BAD_CONFIG" });
      expect(h.exits).toEqual([1]);
    }
  });

  it("les messages envoyés à l'hôte ne portent jamais le texte des requêtes", async () => {
    const h = harness();
    const port = await freePort();
    h.send({ type: "start", config: { modelDir: "/m", port } });
    await h.until(() => h.sent.some((m) => m.type === "ready"));
    await fetch(`http://127.0.0.1:${port}/v1/embeddings`, { method: "POST", body: JSON.stringify({ input: ["TEXTE-CONFIDENTIEL-77"] }) });
    await h.until(() => h.sent.some((m) => m.type === "metrics"));
    expect(JSON.stringify(h.sent)).not.toContain("TEXTE-CONFIDENTIEL-77");
    h.send({ type: "shutdown" });
  });
});
