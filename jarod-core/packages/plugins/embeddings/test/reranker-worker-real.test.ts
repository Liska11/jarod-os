// SPECS-P5-RERANKER.md §6 « Réel » : le VRAI worker (`reranker-worker.mjs`, OpenVINO, bge-reranker-v2-m3 INT8, IR figée 8×512) lancé par l'hôte
// isolé. Ignoré sans l'IR figée. En Node (fork) : la preuve DANS Electron est le protocole §7 (e2e), pas ce test. Le démarrage à froid sur
// NPU dure ≈ 90 s : c'est le fait que ce test établit (l'état reste « starting » jusqu'au « ready »).
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { forkEmbeddingsSpawner } from "../src/isolated.js";
import { IsolatedReranker } from "../src/reranker-isolated.js";
import { RERANKER_WORKER_PATH } from "../src/reranker-isolated.js";

const MODEL = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "tools", "ov-bge-reranker-int8-b8x512");
const HAVE = existsSync(join(MODEL, "openvino_model.xml"));
let host: IsolatedReranker | null = null;

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

const QUERY = "Quels opérateurs mobiles sont couverts par le réseau RMP ?";
const RELEVANT = "Le réseau RMP couvre les opérateurs mobiles Orange, SFR, Bouygues Telecom et Free.";
const OTHERS = [
  "La matrice d'escalade définit les niveaux L1 à L4 et les délais de mise à jour.",
  "Recette de la tarte aux pommes : farine, beurre, sucre.",
  "Le protocole entre les API concentrateurs et PcVue est S7.",
  "Le mode WAL de SQLite autorise des lectures pendant une écriture.",
  "Les baleines bleues se nourrissent surtout de krill.",
];

describe.skipIf(!HAVE)("vrai worker du reranker (OpenVINO)", () => {
  it("compile en arrière-plan (starting → ready), rend le passage pertinent en tête, 16 candidats en deux lots dans l'échéance", { timeout: 420_000 }, async () => {
    const port = await freePort();
    const logs: string[] = [];
    host = new IsolatedReranker({
      spawn: forkEmbeddingsSpawner(),
      script: RERANKER_WORKER_PATH,
      config: { modelDir: MODEL, port, batch: 8, maxLength: 512, devices: ["NPU", "GPU.0", "CPU"] },
      readyTimeoutMs: 300_000,
      log: (l) => logs.push(l),
    });
    const t0 = Date.now();
    host.start();
    expect(host.state).toBe("starting");
    // Pendant la compilation : échec immédiat, jamais d'attente.
    await expect(host.rerank(QUERY, [RELEVANT], 1_000)).rejects.toMatchObject({ code: "RERANKER_UNAVAILABLE" });
    await host.ready();
    const coldMs = Date.now() - t0;
    console.log(`[reranker réel] démarrage à froid ${coldMs} ms, appareil ${host.metrics().device}`);
    expect(host.available).toBe(true);
    expect(["NPU", "GPU.0", "CPU"]).toContain(host.metrics().device);

    // 3 candidats (un lot rempli) : le pertinent est premier.
    const small = await host.rerank(QUERY, [OTHERS[0]!, RELEVANT, OTHERS[1]!], 10_000);
    expect(small).toHaveLength(3);
    expect(small[0]!.index).toBe(1);

    // 16 candidats = deux lots de 8 ; le pertinent est en position 11. Échéance de la gate : 4 000 ms.
    const docs = Array.from({ length: 16 }, (_, i) => (i === 11 ? RELEVANT : `${OTHERS[i % OTHERS.length]} (${i})`));
    const t1 = Date.now();
    const sixteen = await host.rerank(QUERY, docs, 4_000);
    const ms = Date.now() - t1;
    console.log(`[reranker réel] 16 candidats en ${ms} ms`);
    expect(sixteen).toHaveLength(16);
    expect(sixteen[0]!.index).toBe(11);
    expect(ms).toBeLessThan(4_000);
    expect(JSON.stringify([logs, host.metrics()])).not.toContain("opérateurs mobiles");
  });
});
