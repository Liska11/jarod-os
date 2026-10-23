// SPECS-P5-RERANKER.md §2.2, §6 « Desktop » : `openDesktopKernel` lit `<profil>/reranker.json` et lance le worker du reranker ISOLÉ seulement
// avec le fichier ET `rag.enabled` ET `ecosystem.reranker` allumé. Faux worker (aucun OpenVINO) ; le vrai est éprouvé par la gate (Electron).
import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plainCipher } from "@jarod/contracts";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import type { WorkerSpawner } from "@jarod/plugin-voice";
import { afterEach, describe, expect, it } from "vitest";
import { openDesktopKernel } from "../src/main/kernel.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(HERE, "..", "..", "plugins", "embeddings", "test", "fixtures", "fake-reranker-worker.mjs");
afterEach(cleanup);

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

function fakeSpawner(mode = "ok") {
  let n = 0;
  const spawn: WorkerSpawner = () => {
    n++;
    const child = fork(FAKE, [], { execArgv: [], serialization: "advanced", env: { ...process.env, FAKE_MODE: mode }, stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
    return {
      get pid() {
        return child.pid;
      },
      postMessage: (m) => void child.send(m as never),
      onMessage: (cb) => void child.on("message", cb),
      onExit: (cb) => void child.on("exit", (c) => cb(c)),
      kill: () => void child.kill(),
    };
  };
  return { spawn, count: () => n };
}

const BASE = { cipher: plainCipher, appVersion: "1.2.3", testProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "m" } } as const;

async function prepare(o: { rag: boolean; flag: "off" | "bge-reranker-v2-m3-npu" }) {
  const root = tempDir();
  const port = await freePort();
  const file = join(root, "reranker.json");
  writeFileSync(file, JSON.stringify({ modelDir: tmpdir(), port }));
  const first = await openDesktopKernel({ dataRoot: root, ...BASE });
  first.agent.settings.patch({ rag: { ...first.agent.settings.get("rag"), enabled: o.rag }, ecosystem: { ...first.agent.settings.get("ecosystem"), reranker: o.flag } });
  await first.dispose();
  return { root, port, file };
}
const rr = (k: unknown) =>
  (k as { app: { reranker?: { available: boolean; metrics(): { lastError: string | null }; rerank(r: unknown): Promise<{ id: number; score: number }[]> } } }).app.reranker;

describe("desktop : worker du reranker isolé", () => {
  it("sans reranker.json : aucun processus, aucun service reranker (pile d'avant)", async () => {
    const root = tempDir();
    const sp = fakeSpawner();
    const k = await openDesktopKernel({ dataRoot: root, ...BASE, rerankerConfigPath: join(root, "absent.json"), rerankerSpawner: sp.spawn });
    try {
      expect(sp.count()).toBe(0);
      expect(rr(k)).toBeUndefined();
    } finally {
      await k.dispose();
    }
  });

  it("reranker.json mais drapeau éteint (défaut) : AUCUN processus, service inactif avec la raison", async () => {
    const { root, file } = await prepare({ rag: true, flag: "off" });
    const sp = fakeSpawner();
    const k = await openDesktopKernel({ dataRoot: root, ...BASE, rerankerConfigPath: file, rerankerSpawner: sp.spawn });
    try {
      expect(sp.count()).toBe(0);
      expect(rr(k)!.available).toBe(false);
      expect(rr(k)!.metrics().lastError).toMatch(/ecosystem\.reranker/);
    } finally {
      await k.dispose();
    }
  });

  it("reranker.json + rag.enabled + drapeau allumé : un worker, rerank() répond, dispose() le tue", async () => {
    const { root, file } = await prepare({ rag: true, flag: "bge-reranker-v2-m3-npu" });
    const sp = fakeSpawner();
    const k = await openDesktopKernel({ dataRoot: root, ...BASE, rerankerConfigPath: file, rerankerSpawner: sp.spawn });
    try {
      const end = Date.now() + 8_000;
      while (!rr(k)!.available && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      expect(sp.count()).toBe(1);
      const hits = await rr(k)!.rerank({ query: "q", candidates: [{ id: 5, text: "aa" }, { id: 6, text: "bbbb" }], topN: 2, deadlineMs: 2_000 });
      expect(hits).toEqual([{ id: 6, score: 4 }, { id: 5, score: 2 }]);
    } finally {
      await k.dispose();
    }
  });

  it("reranker.json invalide : le noyau refuse de démarrer avec un message qui nomme le fichier", async () => {
    const root = tempDir();
    const file = join(root, "reranker.json");
    writeFileSync(file, JSON.stringify({ modelDir: "relatif", port: 8930 }));
    await expect(openDesktopKernel({ dataRoot: root, ...BASE, rerankerConfigPath: file })).rejects.toThrow(file);
  });

  it("l'observateur des arrêts reçoit les sorties du worker (journal sans texte)", async () => {
    const { root, file } = await prepare({ rag: true, flag: "bge-reranker-v2-m3-npu" });
    const events: unknown[] = [];
    const sp = fakeSpawner("crash-after-ready");
    const k = await openDesktopKernel({ dataRoot: root, ...BASE, rerankerConfigPath: file, rerankerSpawner: sp.spawn, rerankerOnExit: (e) => events.push(e) });
    try {
      const end = Date.now() + 8_000;
      while (events.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      // 0xC0000005 (violation d'accès Windows) ; ailleurs, un code de sortie tient sur 8 bits (3221225477 & 0xff = 5).
      expect(events[0]).toMatchObject({ code: process.platform === "win32" ? 3221225477 : 3221225477 & 0xff, reason: "exit", outcome: "restarted" });
    } finally {
      await k.dispose();
    }
  });
});
