// SPECS-P5-RERANKER.md §2.2, §6 : hôte du worker du reranker ISOLÉ, sans OpenVINO (faux worker). Un plantage natif tue le worker, jamais
// l'application ; relances bornées ; RERANKER_PORT_BUSY / RERANKER_NO_DEVICE francs et sans relance ; une requête n'ATTEND JAMAIS la
// compilation (≈ 90 s sur NPU) : elle échoue tout de suite et l'appelant garde l'ordre d'origine ; aucun texte au journal.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { forkEmbeddingsSpawner as forkSpawner } from "../src/isolated.js";
import { IsolatedReranker, type RerankerWorkerEvent } from "../src/reranker-isolated.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-reranker-worker.mjs");
// Le faux worker meurt avec 0xC0000005 ; hors Windows, un code de sortie ne garde que ses 8 bits de poids faible.
const CRASH_CODE = process.platform === "win32" ? 3221225477 : 3221225477 & 0xff;
const hosts: IsolatedReranker[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

async function make(env: Record<string, string>, over: Partial<ConstructorParameters<typeof IsolatedReranker>[0]> = {}) {
  const port = await freePort();
  let spawned = 0;
  const base = forkSpawner({ env });
  const logs: string[] = [];
  const events: RerankerWorkerEvent[] = [];
  const host = new IsolatedReranker({
    spawn: (script) => {
      spawned++;
      return base(script);
    },
    script: FAKE,
    config: { modelDir: tmpdir(), port, batch: 8, maxLength: 512, devices: ["NPU"] },
    log: (line) => logs.push(line),
    onExit: (e) => events.push(e),
    readyTimeoutMs: 5_000,
    ...over,
  });
  hosts.push(host);
  return { host, port, logs, events, spawned: () => spawned };
}

describe("hôte du worker reranker isolé", () => {
  it("start() ne bloque pas ; l'état reste « starting » jusqu'au « ready » (compilation) ; rerank() rend un classement trié", async () => {
    const { host, port } = await make({ FAKE_MODE: "slow-ready", FAKE_DELAY_MS: "300" });
    host.start();
    expect(host.available).toBe(false);
    expect(host.state).toBe("starting");
    await host.ready();
    expect(host.available).toBe(true);
    expect(host.url).toBe(`http://127.0.0.1:${port}/v1`);
    const hits = await host.rerank("q", ["aa", "bbbbb", "c"], 2_000);
    expect(hits).toEqual([{ index: 1, score: 5 }, { index: 0, score: 2 }, { index: 2, score: 1 }]);
  });

  it("rerank() pendant la compilation : échec IMMÉDIAT RERANKER_UNAVAILABLE, jamais d'attente de « ready »", async () => {
    const { host } = await make({ FAKE_MODE: "slow-ready", FAKE_DELAY_MS: "2000" });
    host.start();
    const t0 = Date.now();
    await expect(host.rerank("q", ["a"], 2_000)).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("rerank() sans start() : RERANKER_UNAVAILABLE", async () => {
    const { host } = await make({});
    await expect(host.rerank("q", ["a"], 1_000)).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
  });

  it("port occupé : RERANKER_PORT_BUSY franc, UN seul lancement, état « failed », ready() rejette avec le code", async () => {
    const { host, spawned, events } = await make({ FAKE_MODE: "port-busy" });
    host.start();
    await expect(host.ready()).rejects.toMatchObject({ code: "RERANKER_PORT_BUSY" });
    expect(host.state).toBe("failed");
    expect(spawned()).toBe(1);
    expect(events).toMatchObject([{ reason: "port-busy", outcome: "gave-up" }]);
    expect(host.lastError?.code).toBe("RERANKER_PORT_BUSY");
  });

  it("aucun appareil : RERANKER_NO_DEVICE franc, aucune relance (elle ne changerait rien)", async () => {
    const { host, spawned } = await make({ FAKE_MODE: "no-device" });
    host.start();
    await expect(host.ready()).rejects.toMatchObject({ code: "RERANKER_NO_DEVICE" });
    expect(spawned()).toBe(1);
  });

  it("plantage natif pendant un rerank : la requête échoue, SANS rejeu ; le processus est relancé et le suivant réussit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-"));
    dirs.push(dir);
    const marker = join(dir, "crashed");
    const { host, events } = await make({ FAKE_MODE: "crash-once-on-rerank", FAKE_MARKER: marker });
    host.start();
    await host.ready();
    await expect(host.rerank("q", ["a", "b"], 3_000)).rejects.toBeInstanceOf(Error);
    expect(existsSync(marker)).toBe(true);
    // la relance est annoncée (événement), le worker repasse par « starting » puis « ready »
    const end = Date.now() + 8_000;
    while ((events.length === 0 || !host.available) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(host.available).toBe(true);
    expect(await host.rerank("q", ["a", "bb"], 3_000)).toEqual([{ index: 1, score: 2 }, { index: 0, score: 1 }]);
    expect(events).toMatchObject([{ code: CRASH_CODE, outcome: "restarted", reason: "exit" }]);
  });

  it("relances bornées : un worker qui meurt à chaque fois est abandonné (RERANKER_WORKER_GAVE_UP)", async () => {
    const { host, events } = await make({ FAKE_MODE: "crash-after-ready" }, { maxRestarts: 2, restartWindowMs: 30_000 });
    host.start();
    const end = Date.now() + 8_000;
    while (host.state !== "failed" && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(host.state).toBe("failed");
    expect(host.lastError?.code).toBe("RERANKER_WORKER_GAVE_UP");
    expect(events.at(-1)).toMatchObject({ outcome: "gave-up" });
  });

  it("pas de « ready » dans le délai : processus arrêté puis relancé (au plus maxRestarts)", async () => {
    const { host, events } = await make({ FAKE_MODE: "never-ready" }, { readyTimeoutMs: 150, maxRestarts: 1, restartWindowMs: 30_000 });
    host.start();
    const end = Date.now() + 5_000;
    while (host.state !== "failed" && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(host.state).toBe("failed");
    expect(events.some((e) => e.reason === "timeout")).toBe(true);
  });

  it("délai dépassé : RERANKER_TIMEOUT à l'échéance ; tant que le worker calcule, un nouvel appel est refusé (RERANKER_BUSY) ; puis ça repart", async () => {
    const { host } = await make({ FAKE_MODE: "slow-rerank", FAKE_RERANK_MS: "600" });
    host.start();
    await host.ready();
    const t0 = Date.now();
    const first = host.rerank("q", ["a", "bb"], 100);
    await expect(first).rejects.toMatchObject({ code: "RERANKER_TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(450); // rendu à l'échéance, pas à la fin du calcul
    await expect(host.rerank("q", ["a"], 100)).rejects.toMatchObject({ code: "RERANKER_BUSY" });
    await new Promise((r) => setTimeout(r, 700)); // le calcul abandonné se termine
    expect(await host.rerank("q", ["a", "bb"], 2_000)).toEqual([{ index: 1, score: 2 }, { index: 0, score: 1 }]);
  });

  it("calcul bloqué (le natif ne répond plus) : après l'échéance puis `stuckMs`, le worker est TUÉ et relancé — l'hôte ne reste jamais « occupé » pour toujours", async () => {
    const { host, events } = await make({ FAKE_MODE: "hang-rerank" }, { stuckMs: 250 });
    host.start();
    await host.ready();
    await expect(host.rerank("q", ["a"], 100)).rejects.toMatchObject({ code: "RERANKER_TIMEOUT" });
    await expect(host.rerank("q", ["a"], 100)).rejects.toMatchObject({ code: "RERANKER_BUSY" });
    const end = Date.now() + 8_000;
    while ((events.length === 0 || !host.available) && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    expect(events[0]).toMatchObject({ outcome: "restarted" });
    expect(host.available).toBe(true);
  });

  it("stop() : plus aucun processus, plus de relance ; idempotent", async () => {
    const { host } = await make({});
    host.start();
    await host.ready();
    const pid = host.pid!;
    await host.stop();
    await host.stop();
    expect(host.state).toBe("stopped");
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("le journal ne contient que des pids, ports et codes — jamais la requête ni un document", async () => {
    const { host, logs } = await make({});
    host.start();
    await host.ready();
    await host.rerank("SECRET-REQUETE", ["SECRET-DOC-1", "SECRET-DOC-2"], 2_000);
    expect(JSON.stringify([logs, host.metrics()])).not.toContain("SECRET");
  });
});

// SPECS-P5-RERANKER-PAUSE.md §3 : le lancement du worker (premier démarrage ET relances) attend que la voix soit libre ; pas de compilation
// pendant une dictée. Une compilation déjà en cours n'est pas interrompue.
describe("hôte du worker reranker — lancement différé par la voix", () => {
  const gate = () => {
    let open: () => void = () => {};
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it("start() pendant une dictée : aucun processus lancé tant que la voix n'est pas libre, puis lancement ; l'état reste « starting » (rerank refuse sans attendre)", async () => {
    const g = gate();
    const { host, spawned } = await make({}, { beforeLaunch: () => g.p });
    host.start();
    expect(host.state).toBe("starting");
    await new Promise((r) => setTimeout(r, 150));
    expect(spawned()).toBe(0);
    await expect(host.rerank("q", ["a"], 500)).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
    g.open();
    await host.ready();
    expect(spawned()).toBe(1);
    expect(host.available).toBe(true);
  });

  it("voix libre : lancement sans délai perceptible (même chemin qu'avant)", async () => {
    const { host, spawned } = await make({}, { beforeLaunch: async () => {} });
    host.start();
    await host.ready();
    expect(spawned()).toBe(1);
  });

  it("stop() pendant l'attente : rien n'est jamais lancé, ready() rejette", async () => {
    const g = gate();
    const { host, spawned } = await make({}, { beforeLaunch: () => g.p });
    host.start();
    const ready = host.ready();
    ready.catch(() => {});
    await host.stop();
    g.open();
    await new Promise((r) => setTimeout(r, 150));
    expect(spawned()).toBe(0);
    await expect(ready).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
    expect(host.state).toBe("stopped");
  });

  it("stop() puis start() pendant l'attente : l'ancienne attente ne lance pas un second processus", async () => {
    const g1 = gate();
    const g2 = gate();
    let n = 0;
    const { host, spawned } = await make({}, { beforeLaunch: () => (++n === 1 ? g1.p : g2.p) });
    host.start();
    await host.stop();
    host.start();
    g1.open();
    await new Promise((r) => setTimeout(r, 100));
    expect(spawned()).toBe(0);
    g2.open();
    await host.ready();
    expect(spawned()).toBe(1);
  });

  it("RELANCE après la mort du worker pendant une dictée : la relance attend aussi la voix libre", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-"));
    dirs.push(dir);
    const marker = join(dir, "crashed");
    let voiceBusy = false;
    let release: () => void = () => {};
    const { host, spawned, events } = await make(
      { FAKE_MODE: "crash-once-on-rerank", FAKE_MARKER: marker },
      {
        beforeLaunch: () => {
          if (!voiceBusy) return Promise.resolve();
          return new Promise<void>((r) => (release = r));
        },
      },
    );
    host.start();
    await host.ready();
    voiceBusy = true; // la dictée s'ouvre
    await expect(host.rerank("q", ["a", "b"], 3_000)).rejects.toBeInstanceOf(Error); // le worker meurt
    const end = Date.now() + 5_000;
    while (events.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(events).toMatchObject([{ outcome: "restarted" }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned()).toBe(1); // pas relancé pendant la dictée
    expect(host.available).toBe(false);
    voiceBusy = false;
    release();
    await host.ready();
    expect(spawned()).toBe(2);
    expect(host.available).toBe(true);
  });

  it("une attente qui lève (voix défaillante) ne bloque pas le lancement (fail-open) et est journalisée", async () => {
    const { host, spawned, logs } = await make({}, { beforeLaunch: () => Promise.reject(new Error("voix HS")) });
    host.start();
    await host.ready();
    expect(spawned()).toBe(1);
    expect(logs.join(" | ")).toMatch(/voix HS/);
  });
});

