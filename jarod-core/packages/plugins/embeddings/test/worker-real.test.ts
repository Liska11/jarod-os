// SPECS-P5-EMBEDDINGS.md §6 « Réel » : le VRAI worker (`embeddings-worker.mjs`, OpenVINO, bge-m3 INT8) lancé par l'hôte isolé.
// Ignoré sans le modèle. En Node (fork) : la preuve DANS Electron est le protocole §7 (e2e), pas ce test.
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EMBEDDINGS_WORKER_PATH, forkEmbeddingsSpawner, IsolatedEmbeddings } from "../src/isolated.js";

const MODEL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "tools", "ov-bge-m3-int8");
const HAVE = existsSync(join(MODEL, "openvino_model.xml"));
let host: IsolatedEmbeddings | null = null;

afterAll(async () => {
  await host?.stop();
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolvePort(port));
    });
  });
}

describe.skipIf(!HAVE)("vrai worker d'embeddings (OpenVINO)", () => {
  it("démarre, répond sur /v1/models, rend un vecteur de 1024 composantes normé, et remonte les appareils", { timeout: 180_000 }, async () => {
    const port = await freePort();
    host = new IsolatedEmbeddings({ spawn: forkEmbeddingsSpawner(), script: EMBEDDINGS_WORKER_PATH, config: { modelDir: MODEL, port }, readyTimeoutMs: 60_000 });
    host.start();
    await host.ready();
    expect(host.url).toBe(`http://127.0.0.1:${port}/v1`);
    expect(((await (await fetch(`${host.url}/models`)).json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);
    const [v] = await host.embed(["La vérification quotidienne des équipements."]);
    expect(v!.length).toBe(1024);
    const norm = Math.sqrt(Array.from(v!).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
    await new Promise((r) => setTimeout(r, 200));
    expect(host.metrics().available).toBe(true);
    expect(Object.keys(host.metrics().device).length).toBeGreaterThan(0);
  });
});
