// SPECS-P5-EMBEDDINGS.md §3.4, §6 : le plugin `embeddings` lance le worker ISOLÉ seulement si la configuration `isolation` est
// donnée ET que `rag.enabled` est vrai dans le profil ; sinon rien ne démarre. Faux worker, aucun OpenVINO.
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { forkEmbeddingsSpawner } from "../src/isolated.js";
import type {} from "../src/index.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-embeddings-worker.mjs");
afterEach(cleanup);

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

/** Un profil dont `rag.enabled` est posé AVANT le démarrage du plugin (le plugin lit le réglage à son démarrage). */
async function profile(ragEnabled: boolean): Promise<string> {
  const dataDir = tempDir();
  const first = await bootApp({ storage: { dataDir, encryptDb: false } });
  (first as any).storage.settings.set("rag", { ...(first as any).storage.settings.get("rag"), enabled: ragEnabled });
  await shutdown(first);
  return dataDir;
}

function spawner() {
  let n = 0;
  const base = forkEmbeddingsSpawner({ env: { FAKE_MODE: "ok" } });
  return { spawn: (script: string) => (n++, base(script)), count: () => n };
}

describe("plugin embeddings : worker isolé", () => {
  it("rag.enabled vrai : un worker est lancé, l'URL est celle du port fixe, embed() passe par lui, l'arrêt du noyau le tue", async () => {
    const dataDir = await profile(true);
    const port = await freePort();
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { modelDir: tmpdir(), port, isolation: { spawn: sp.spawn, script: FAKE } } });
    await app.embeddings.host!.ready();
    expect(sp.count()).toBe(1);
    expect(app.embeddings.url).toBe(`http://127.0.0.1:${port}/v1`);
    expect(app.embeddings.available).toBe(true);
    expect(Array.from((await app.embeddings.embed(["abcd"]))[0]!)).toEqual([4, 1, 0, 0]);
    const pid = app.embeddings.host!.pid!;
    await shutdown(app);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("rag.enabled faux : AUCUN processus, service indisponible avec la raison dite", async () => {
    const dataDir = await profile(false);
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { modelDir: tmpdir(), port: await freePort(), isolation: { spawn: sp.spawn, script: FAKE } } });
    expect(sp.count()).toBe(0);
    expect(app.embeddings.available).toBe(false);
    expect(app.embeddings.url).toBeNull();
    expect(app.embeddings.metrics().lastError).toMatch(/RAG éteint/);
    await expect(app.embeddings.embed(["x"])).rejects.toThrow(/EMBEDDINGS_UNAVAILABLE|RAG éteint/);
  });

  it("sans clé `isolation` : comportement d'avant, aucun processus", async () => {
    const dataDir = await profile(true);
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { port: 0 } });
    expect(app.embeddings.host).toBeNull();
    expect(app.embeddings.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });

  it("isolation sans modelDir ou sans port : aucun processus, erreur dite (pas de port deviné)", async () => {
    const dataDir = await profile(true);
    const sp = spawner();
    for (const cfg of [{ port: await freePort() }, { modelDir: tmpdir() }]) {
      const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { ...cfg, isolation: { spawn: sp.spawn, script: FAKE } } });
      expect(sp.count()).toBe(0);
      expect(app.embeddings.available).toBe(false);
      expect(app.embeddings.metrics().lastError).toMatch(/modelDir|port/);
      await shutdown(app);
    }
  });

  it("port occupé : le noyau démarre quand même, le service reste indisponible avec EMBEDDINGS_PORT_BUSY", async () => {
    const dataDir = await profile(true);
    const port = await freePort();
    const base = forkEmbeddingsSpawner({ env: { FAKE_MODE: "port-busy" } });
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { modelDir: tmpdir(), port, isolation: { spawn: base, script: FAKE } } });
    await expect(app.embeddings.host!.ready()).rejects.toMatchObject({ code: "EMBEDDINGS_PORT_BUSY" });
    expect(app.embeddings.available).toBe(false);
    expect(app.embeddings.metrics().lastError).toMatch(/EMBEDDINGS_PORT_BUSY/);
  });
});
