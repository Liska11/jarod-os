// SPECS-P5-EMBEDDINGS.md §3, §6 « Desktop » : `openDesktopKernel` lit `<profil>/embeddings.json` et lance le worker d'embeddings
// ISOLÉ seulement avec le fichier ET `rag.enabled`. Faux worker (aucun OpenVINO) ; le vrai est éprouvé par le protocole §7 (Electron).
import { fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plainCipher } from "@jarod/contracts";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import type { WorkerSpawner } from "@jarod/plugin-voice";
import { afterEach, describe, expect, it } from "vitest";
import { embeddingsExitJournal } from "../src/main/embeddings-journal.js";
import { type OpenedKernel, openDesktopKernel } from "../src/main/kernel.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(HERE, "..", "..", "plugins", "embeddings", "test", "fixtures", "fake-embeddings-worker.mjs");

// Un test arrêté sur délai laisse son ouverture de noyau EN VOL : `cleanup()` supprimait alors le dossier tandis que la base du noyau y était ouverte
// (EPERM sous Windows, mesuré). Chaque noyau ouvert ici est donc suivi, attendu puis libéré (une seule fois) AVANT le nettoyage des dossiers.
const opening: Promise<OpenedKernel>[] = [];
function open(o: Parameters<typeof openDesktopKernel>[0]): Promise<OpenedKernel> {
  const p = openDesktopKernel(o).then((k) => {
    const real = k.dispose.bind(k);
    let done: Promise<void> | undefined;
    k.dispose = () => (done ??= real());
    return k;
  });
  opening.push(p);
  return p;
}
afterEach(async () => {
  for (const p of opening.splice(0)) await (await p.catch(() => null))?.dispose();
  await cleanup();
}, 15_000); // même échelle que le délai du bloc : le crochet attend une ouverture encore en vol

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

/** Lanceur de test : ignore le script réel et lance le faux worker ; compte les lancements. */
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

const ABS_MODEL = tmpdir(); // le faux worker n'ouvre pas le modèle ; un chemin absolu existant suffit au lecteur

async function prepare(ragEnabled: boolean) {
  const root = tempDir();
  const port = await freePort();
  const file = join(root, "embeddings.json");
  writeFileSync(file, JSON.stringify({ modelDir: ABS_MODEL, port }));
  const first = await open({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3", testProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "m" } });
  first.agent.settings.patch({ rag: { ...first.agent.settings.get("rag"), enabled: ragEnabled } });
  await first.dispose();
  return { root, port, file };
}

const rag = (k: unknown) => (k as { app: { rag: { rag: { status(): { endpoint: string | null }; ingest(t: string, o: { docId: string; source: string }): Promise<unknown>; search(q: string, k?: number): Promise<{ docId?: string }[]> } } } }).app.rag.rag;
const emb = (k: unknown) => (k as { app: { embeddings: { host: { ready(): Promise<void>; pid?: number } | null; url: string | null; available: boolean } } }).app.embeddings;

// Délai propre à CE bloc (jamais un `testTimeout` global) : l'ouverture d'un noyau coûte ~1,8 s à froid, ~0,5 s à chaud, et dépasse 5 s sous charge (DECISIONS 2026-10-03).
describe("desktop : worker d'embeddings isolé", { timeout: 15_000 }, () => {
  it("sans embeddings.json : aucun processus, aucune URL par défaut (pile d'avant)", async () => {
    const root = tempDir();
    const sp = fakeSpawner();
    const k = await open({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3", testProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "m" }, embeddingsConfigPath: join(root, "absent.json"), embeddingsSpawner: sp.spawn });
    try {
      expect(sp.count()).toBe(0);
      expect(emb(k).host).toBeNull();
      // Comportement d'avant : le point d'accès est celui du fournisseur actif (ici le stub local), aucune URL de worker.
      expect(rag(k).status().endpoint).toBe("http://127.0.0.1:1/v1/embeddings");
    } finally {
      await k.dispose();
    }
  });

  it("embeddings.json mais rag.enabled faux : AUCUN processus ; l'URL par défaut du RAG est posée (port fixe)", async () => {
    const { root, port, file } = await prepare(false);
    const sp = fakeSpawner();
    const k = await open({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3", testProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "m" }, embeddingsConfigPath: file, embeddingsSpawner: sp.spawn });
    try {
      expect(sp.count()).toBe(0);
      expect(emb(k).available).toBe(false);
      expect(rag(k).status().endpoint).toBe(`http://127.0.0.1:${port}/v1/embeddings`);
    } finally {
      await k.dispose();
    }
  });

  it("embeddings.json + rag.enabled : un worker, et le RAG ingère puis retrouve SANS aucun réglage d'URL", async () => {
    const { root, port, file } = await prepare(true);
    const sp = fakeSpawner();
    const k = await open({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3", testProvider: { baseUrl: "http://127.0.0.1:1/v1", model: "m" }, embeddingsConfigPath: file, embeddingsSpawner: sp.spawn });
    let pid: number | undefined;
    try {
      await emb(k).host!.ready();
      pid = emb(k).host!.pid;
      expect(sp.count()).toBe(1);
      expect(emb(k).url).toBe(`http://127.0.0.1:${port}/v1`);
      expect(k.agent.settings.get("rag").embeddingsUrl).toBe("");
      await rag(k).ingest("Un texte de test à indexer par le worker isolé.", { docId: "d1", source: "d1" });
      const hits = await rag(k).search("texte de test", 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(k.agent.settings.get("rag").embeddingsUrl).toBe(""); // toujours jamais écrite dans les réglages
    } finally {
      await k.dispose();
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid!, 0)).toThrow(); // dispose() tue le worker : aucun orphelin
  });

  it("embeddings.json invalide : le noyau refuse de démarrer avec un message qui nomme le fichier", async () => {
    const root = tempDir();
    const file = join(root, "embeddings.json");
    writeFileSync(file, JSON.stringify({ modelDir: "relatif", port: 8920 }));
    await expect(open({ dataRoot: root, cipher: plainCipher, appVersion: "1.2.3", embeddingsConfigPath: file })).rejects.toThrow(file);
  });
});

describe("journal des sorties du worker d'embeddings", () => {
  it("une ligne JSON par sortie : pid, code, motif, issue, relances, horodatage — jamais de texte", () => {
    const file = join(tempDir(), "logs", "embeddings-worker.jsonl");
    const onExit = embeddingsExitJournal(file, () => 1_700_000_000_000);
    onExit({ pid: 4242, code: 3221225477, reason: "exit", outcome: "restarted", restartsInWindow: 1 });
    onExit({ pid: 4243, code: 1, reason: "port-busy", outcome: "gave-up", restartsInWindow: 1 });
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { at: 1_700_000_000_000, pid: 4242, code: 3221225477, reason: "exit", outcome: "restarted", restartsInWindow: 1 },
      { at: 1_700_000_000_000, pid: 4243, code: 1, reason: "port-busy", outcome: "gave-up", restartsInWindow: 1 },
    ]);
  });

  it("un journal illisible (dossier impossible) ne casse jamais la relance", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bloque"), ""); // un FICHIER là où il faudrait un dossier : l'écriture échoue
    const onExit = embeddingsExitJournal(join(dir, "bloque", "journal.jsonl"));
    expect(() => onExit({ pid: 1, code: 1, reason: "exit", outcome: "restarted", restartsInWindow: 1 })).not.toThrow();
  });
});
