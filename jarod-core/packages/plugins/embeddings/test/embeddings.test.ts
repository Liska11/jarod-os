// plugin-embeddings sans matériel : contrat, indisponibilité dite, point d'accès HTTP.
// L'exécution réelle sur NPU est vérifiée par la gate P2 (tests/gates/p2.test.ts).
import { EmbeddingsConfig } from "@jarod/contracts";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";

afterEach(cleanup);

describe("plugin-embeddings", () => {
  it("défauts : NPU puis iGPU puis CPU, formes 128/512, CLS + L2, compilation paresseuse", () => {
    expect(EmbeddingsConfig.parse({})).toEqual({
      devices: ["NPU", "GPU.0", "CPU"],
      queryMaxLength: 128,
      docMaxLength: 512,
      pooling: "cls",
      normalize: true,
      warmup: false,
    });
  });

  it("sans modèle : indisponible, et le dit au lieu d'échouer en silence", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, embeddings: {} });
    expect(app.embeddings.available).toBe(false);
    await expect(app.embeddings.embed(["x"])).rejects.toThrow(/aucun modèle configuré/);
    expect(app.embeddings.metrics()).toMatchObject({ available: false, calls: 0, lastError: expect.stringMatching(/modèle/) });
  });

  it("point d'accès OpenAI-compatible sur 127.0.0.1 : modèles, erreurs de forme, 404", async () => {
    const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, embeddings: { port: 0 } });
    const url = app.embeddings.url!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(await (await fetch(`${url}/models`)).json()).toMatchObject({ data: [{ id: "openvino-embeddings" }] });
    const bad = await fetch(`${url}/embeddings`, { method: "POST", body: JSON.stringify({ input: 42 }) });
    expect(bad.status).toBe(400);
    const noModel = await fetch(`${url}/embeddings`, { method: "POST", body: JSON.stringify({ input: "x" }) });
    expect(noModel.status).toBe(500);
    expect(((await noModel.json()) as { error: { message: string } }).error.message).toMatch(/modèle/);
    expect((await fetch(`${url}/ailleurs`)).status).toBe(404);
  });
});
