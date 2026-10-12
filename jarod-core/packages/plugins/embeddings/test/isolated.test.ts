// SPECS-P5-EMBEDDINGS.md §3.2–3.3, §6 : hôte d'un worker d'embeddings ISOLÉ (processus dédié), sans OpenVINO (faux worker).
// Un plantage natif tue le worker, jamais l'application ; relances bornées ; EMBEDDINGS_PORT_BUSY franc ; aucun texte au journal.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { forkEmbeddingsSpawner, IsolatedEmbeddings, type EmbeddingsWorkerEvent } from "../src/isolated.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-embeddings-worker.mjs");
const hosts: IsolatedEmbeddings[] = [];
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

async function make(env: Record<string, string>, over: Partial<ConstructorParameters<typeof IsolatedEmbeddings>[0]> = {}) {
  const port = await freePort();
  let spawned = 0;
  const base = forkEmbeddingsSpawner({ env });
  const logs: string[] = [];
  const events: EmbeddingsWorkerEvent[] = [];
  const host = new IsolatedEmbeddings({
    spawn: (script) => {
      spawned++;
      return base(script);
    },
    script: FAKE,
    config: { modelDir: tmpdir(), port },
    log: (line) => logs.push(line),
    onExit: (e) => events.push(e),
    readyTimeoutMs: 5_000,
    ...over,
  });
  hosts.push(host);
  return { host, port, logs, events, spawned: () => spawned };
}

describe("hôte du worker d'embeddings isolé", () => {
  it("start() ne bloque pas ; ready() attend le port ; l'URL est celle du port fixe ; embed() passe par HTTP", async () => {
    const { host, port } = await make({ FAKE_MODE: "slow-ready", FAKE_DELAY_MS: "250" });
    host.start();
    expect(host.available).toBe(false);
    expect(host.state).toBe("starting");
    await host.ready();
    expect(host.available).toBe(true);
    expect(host.url).toBe(`http://127.0.0.1:${port}/v1`);
    const v = await host.embed(["abc", "de"]);
    expect(v.map((x) => Array.from(x))).toEqual([[3, 1, 0, 0], [2, 1, 0, 0]]);
    expect(v[0]).toBeInstanceOf(Float32Array);
  });

  it("les métriques poussées par le worker sont celles de l'hôte (preuve des appareils)", async () => {
    const { host } = await make({ FAKE_MODE: "ok" });
    host.start();
    await host.ready();
    expect(host.metrics().calls).toBe(0);
    await host.embed(["x"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(host.metrics()).toMatchObject({ available: true, device: { 128: "NPU" }, calls: 1 });
  });

  it("plantage natif pendant une requête : le worker est relancé et l'appel est rejoué (résultat identique)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarod-emb-"));
    dirs.push(dir);
    const { host, events, spawned } = await make({ FAKE_MODE: "crash-once-on-embed", FAKE_MARKER: join(dir, "marker") });
    host.start();
    await host.ready();
    const v = await host.embed(["abcd"]);
    expect(Array.from(v[0]!)).toEqual([4, 1, 0, 0]);
    expect(existsSync(join(dir, "marker"))).toBe(true);
    expect(spawned()).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "restarted", code: 3221225477 });
    expect(host.available).toBe(true);
  });

  it("pid des événements : connu dès que le worker parle, même si le processus l'ignore au lancement et l'oublie à sa mort (utilityProcess d'Electron)", async () => {
    const { host, events } = await make({ FAKE_MODE: "crash-after-ready" }, { maxRestarts: 0 });
    const inner = (host as unknown as { opts: { spawn: (s: string) => any } }).opts;
    const real = inner.spawn;
    const seen: (number | undefined)[] = [];
    inner.spawn = (script: string) => {
      const p = real(script);
      let spawned = false;
      let dead = false;
      p.onMessage(() => (spawned = true)); // comme `utilityProcess` : le pid n'existe qu'après le démarrage…
      p.onExit(() => (dead = true)); // …et disparaît à la mort
      seen.push(p.pid);
      return { postMessage: p.postMessage, onMessage: p.onMessage, onExit: p.onExit, kill: p.kill, get pid() { return spawned && !dead ? p.pid : undefined; } };
    };
    host.start();
    await expect(settle(host)).resolves.toBe("failed");
    expect(events).toHaveLength(1);
    expect(events[0]!.pid).toBe(seen[0]);
    expect(events[0]!.pid).not.toBeNull();
  });

  it("relances bornées : au-delà du quota, abandon EMBEDDINGS_WORKER_GAVE_UP, jamais de boucle", async () => {
    const { host, events, spawned, logs } = await make({ FAKE_MODE: "crash-after-ready" }, { maxRestarts: 2, restartWindowMs: 60_000 });
    host.start();
    await expect(settle(host)).resolves.toBe("failed");
    expect(spawned()).toBe(3);
    expect(events.map((e) => e.outcome)).toEqual(["restarted", "restarted", "gave-up"]);
    expect(host.available).toBe(false);
    expect(host.lastError?.code).toBe("EMBEDDINGS_WORKER_GAVE_UP");
    await expect(host.embed(["x"])).rejects.toMatchObject({ code: "EMBEDDINGS_WORKER_GAVE_UP" });
    expect(logs.join("\n")).toMatch(/GAVE_UP/);
  });

  it("port occupé : erreur franche EMBEDDINGS_PORT_BUSY, AUCUNE relance, aucun repli sur un autre port", async () => {
    const { host, spawned, logs, events } = await make({ FAKE_MODE: "port-busy" });
    host.start();
    await expect(host.ready()).rejects.toMatchObject({ code: "EMBEDDINGS_PORT_BUSY" });
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned()).toBe(1);
    expect(host.state).toBe("failed");
    expect(host.available).toBe(false);
    expect(host.lastError).toMatchObject({ code: "EMBEDDINGS_PORT_BUSY" });
    await expect(host.embed(["x"])).rejects.toThrow(/EMBEDDINGS_PORT_BUSY/);
    expect(logs.join("\n")).toMatch(/EMBEDDINGS_PORT_BUSY/);
    expect(events.every((e) => e.outcome === "gave-up")).toBe(true);
  });

  it("worker qui ne répond jamais : délai de démarrage, processus tué, compté comme un plantage", async () => {
    const { host, spawned } = await make({ FAKE_MODE: "never-ready" }, { readyTimeoutMs: 150, maxRestarts: 1 });
    host.start();
    await expect(settle(host)).resolves.toBe("failed");
    expect(spawned()).toBe(2);
    expect(host.lastError?.code).toBe("EMBEDDINGS_WORKER_GAVE_UP");
  });

  it("stop() : le processus meurt, pas de relance, idempotent", async () => {
    const { host, spawned } = await make({ FAKE_MODE: "ok" });
    host.start();
    await host.ready();
    const pid = host.pid!;
    await host.stop();
    await host.stop();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(spawned()).toBe(1);
    expect(host.state).toBe("stopped");
    expect(host.available).toBe(false);
  });

  it("le journal ne contient jamais le texte embarqué", async () => {
    const { host, logs } = await make({ FAKE_MODE: "ok" });
    host.start();
    await host.ready();
    await host.embed(["SECRET-DU-DOCUMENT-42"]);
    await host.stop();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain("SECRET-DU-DOCUMENT-42");
  });

  it("embed() avant start() : erreur nette, pas d'attente infinie", async () => {
    const { host } = await make({ FAKE_MODE: "ok" });
    await expect(host.embed(["x"])).rejects.toMatchObject({ code: "EMBEDDINGS_UNAVAILABLE" });
  });
});

/** Attend un état terminal (prêt ou échec définitif) sans rien supposer des relances intermédiaires. */
async function settle(host: IsolatedEmbeddings): Promise<string> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (host.state === "failed" || host.state === "stopped") return host.state;
    await new Promise((r) => setTimeout(r, 25));
  }
  return host.state;
}
