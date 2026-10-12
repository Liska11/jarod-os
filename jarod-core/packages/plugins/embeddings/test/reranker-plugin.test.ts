// SPECS-P5-RERANKER.md §2.2 : le plugin lance le worker du reranker SEULEMENT si `reranker` est configuré (reranker.json) ET que
// `rag.enabled` est vrai ET que `ecosystem.reranker` n'est pas « off » ; sinon rien ne démarre et le service dit pourquoi.
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { bootApp, cleanup, shutdown, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { forkEmbeddingsSpawner } from "../src/isolated.js";
import type {} from "../src/index.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-reranker-worker.mjs");
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

/** Un profil réglé AVANT le démarrage du plugin (le plugin lit les réglages à son démarrage). */
async function profile(o: { rag: boolean; reranker: "off" | "bge-reranker-v2-m3-npu" }): Promise<string> {
  const dataDir = tempDir();
  const first = await bootApp({ storage: { dataDir, encryptDb: false } });
  const s = (first as any).storage.settings;
  s.set("rag", { ...s.get("rag"), enabled: o.rag });
  s.set("ecosystem", { ...s.get("ecosystem"), reranker: o.reranker });
  await shutdown(first);
  return dataDir;
}

function spawner() {
  let n = 0;
  const base = forkEmbeddingsSpawner({ env: { FAKE_MODE: "ok" } });
  return { spawn: (script: string) => (n++, base(script)), count: () => n };
}
const rr = async (sp: ReturnType<typeof spawner>) => ({ modelDir: tmpdir(), port: await freePort(), isolation: { spawn: sp.spawn, script: FAKE } });

describe("plugin embeddings : service reranker", () => {
  it("RAG allumé + drapeau allumé + configuré : un worker est lancé, rerank() passe par lui, l'arrêt du noyau le tue", async () => {
    const dataDir = await profile({ rag: true, reranker: "bge-reranker-v2-m3-npu" });
    const sp = spawner();
    const cfg = await rr(sp);
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: cfg } });
    const svc = (app as any).reranker;
    // l'hôte n'est pas exposé par le service : on attend « available »
    const end = Date.now() + 5_000;
    while (!svc.available && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(sp.count()).toBe(1);
    expect(svc.available).toBe(true);
    expect(svc.info()).toMatchObject({ name: "bge-reranker-v2-m3", version: "int8-b8x512", device: "NPU" });
    const hits = await svc.rerank({ query: "q", candidates: [{ id: 1, text: "aa" }, { id: 2, text: "bbbb" }], topN: 2, deadlineMs: 2_000 });
    expect(hits).toEqual([{ id: 2, score: 4 }, { id: 1, score: 2 }]);
    await shutdown(app);
  });

  it("drapeau `ecosystem.reranker` éteint (le défaut) : AUCUN processus, service inactif avec la raison dite", async () => {
    const dataDir = await profile({ rag: true, reranker: "off" });
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: await rr(sp) } });
    const svc = (app as any).reranker;
    expect(sp.count()).toBe(0);
    expect(svc.available).toBe(false);
    expect(svc.metrics().lastError).toMatch(/ecosystem\.reranker/);
    await expect(svc.rerank({ query: "q", candidates: [{ id: 1, text: "a" }], topN: 1, deadlineMs: 100 })).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
  });

  it("RAG éteint : AUCUN processus (le reranker ne sert qu'au RAG), raison dite", async () => {
    const dataDir = await profile({ rag: false, reranker: "bge-reranker-v2-m3-npu" });
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: await rr(sp) } });
    expect(sp.count()).toBe(0);
    expect((app as any).reranker.metrics().lastError).toMatch(/RAG éteint/);
  });

  it("pas de configuration `reranker` : aucun service fourni, rien ne change", async () => {
    const dataDir = await profile({ rag: true, reranker: "bge-reranker-v2-m3-npu" });
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: {} });
    expect((app as any).reranker).toBeUndefined();
  });

  it("configuration invalide (port absent) : aucun processus, service inactif avec la raison, le noyau démarre", async () => {
    const dataDir = await profile({ rag: true, reranker: "bge-reranker-v2-m3-npu" });
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: { modelDir: tmpdir(), isolation: { spawn: sp.spawn, script: FAKE } } as never } });
    expect(sp.count()).toBe(0);
    expect((app as any).reranker.available).toBe(false);
    expect((app as any).reranker.metrics().lastError).toMatch(/reranker\.json|invalide/);
  });

  it("port occupé : le noyau démarre, le service reste indisponible avec RERANKER_PORT_BUSY", async () => {
    const dataDir = await profile({ rag: true, reranker: "bge-reranker-v2-m3-npu" });
    const cfg = { modelDir: tmpdir(), port: await freePort(), isolation: { spawn: forkEmbeddingsSpawner({ env: { FAKE_MODE: "port-busy" } }), script: FAKE } };
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: cfg } });
    const end = Date.now() + 5_000;
    while (!/RERANKER_PORT_BUSY/.test(String((app as any).reranker.metrics().lastError)) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect((app as any).reranker.available).toBe(false);
    expect((app as any).reranker.metrics().lastError).toMatch(/RERANKER_PORT_BUSY/);
  });
});

// SPECS-P5-RERANKER-PAUSE.md : la priorité de la voix (ctx.root.voice.priority, lue paresseusement) vaut pour le service ET pour la relance du worker.
describe("plugin embeddings : le reranker cède la place à la voix", () => {
  function voice(active: boolean) {
    let waiters: (() => void)[] = [];
    const priority = {
      active,
      whenIdle: () => (priority.active ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
    };
    return {
      priority,
      free: () => {
        priority.active = false;
        for (const w of waiters.splice(0)) w();
      },
    };
  }
  const req = { query: "q", candidates: [{ id: 1, text: "aa" }, { id: 2, text: "bbbb" }], topN: 2, deadlineMs: 2_000 };
  const until = async (pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  };

  it("voix active : reclassement refusé (RERANKER_PAUSED), worker intact ; voix libre : il repasse", async () => {
    const dataDir = await profile({ rag: true, reranker: "bge-reranker-v2-m3-npu" });
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: await rr(sp) } });
    const svc = (app as any).reranker;
    await until(() => svc.available, 5_000);
    const v = voice(true);
    (app as any).voice = { priority: v.priority };
    await expect(svc.rerank(req)).rejects.toMatchObject({ code: "RERANKER_PAUSED" });
    expect(svc.pausedCount).toBe(1);
    expect(svc.available).toBe(true);
    v.free();
    expect(await svc.rerank(req)).toHaveLength(2);
    await shutdown(app);
  });

  it("le worker meurt pendant une dictée : il n'est PAS relancé tant que la voix n'est pas libre (pas de compilation en pleine transcription)", async () => {
    const dataDir = await profile({ rag: true, reranker: "bge-reranker-v2-m3-npu" });
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: await rr(sp) } });
    const svc = (app as any).reranker;
    await until(() => svc.available, 5_000);
    const v = voice(true);
    (app as any).voice = { priority: v.priority };
    process.kill(svc.pid);
    await until(() => !svc.available, 3_000);
    await new Promise((r) => setTimeout(r, 400));
    expect(sp.count()).toBe(1);
    expect(svc.available).toBe(false);
    v.free();
    await until(() => svc.available, 8_000);
    expect(sp.count()).toBe(2);
    expect(svc.available).toBe(true);
    await shutdown(app);
  });

  it("voicePriority:false (témoin du banc) : le service ne se met jamais en pause, la relance n'attend pas", async () => {
    const dataDir = await profile({ rag: true, reranker: "bge-reranker-v2-m3-npu" });
    const sp = spawner();
    const app = await bootApp({ storage: { dataDir, encryptDb: false }, embeddings: { reranker: { ...(await rr(sp)), voicePriority: false } } });
    const svc = (app as any).reranker;
    await until(() => svc.available, 5_000);
    (app as any).voice = { priority: voice(true).priority };
    expect(await svc.rerank(req)).toHaveLength(2);
    expect(svc.pausedCount).toBe(0);
    await shutdown(app);
  });
});

