/**
 * Alternative simple du bench Q16 : bge-m3 zéro-exemple par le kernel réel (plugin embeddings → OpenVINO →
 * NPU, comme la gate P2). Vecteurs des 60 requêtes FR, des 60 EN et des 5 descriptions d'options
 * (`INTENT_DESCRIPTIONS`, mêmes textes que ceux donnés à Laya) → `.work/q16/bge.json`. Un seul kernel par
 * processus (un second perd le NPU, constaté le 2026-09-29).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { readEmbeddings } from "@jarod/plugin-rag";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { FIXTURES, INTENT_DESCRIPTIONS, INTENTS } from "./q16-fixtures.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
export const BGE_FILE = join(ROOT, ".work", "q16", "bge.json");

export interface BgeVectors {
  device: Record<string, string>;
  fr: number[][];
  en: number[][];
  desc: Record<string, number[]>;
}

async function main() {
  const plugins: Record<string, Record<string, unknown>> = {};
  for (const p of discoverPlugins()) plugins[p.name] = {};
  plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
  plugins.scheduler = { autoStart: false };
  plugins.agent = { runtimeLock: false };
  plugins.embeddings = { modelDir: MODEL, port: 0 };
  const app = new JarodApp({ plugins });
  const started = await start(app);
  try {
    const emb = (app as unknown as { embeddings: { url: string; metrics(): EmbeddingsMetrics } }).embeddings;
    const texts = [...FIXTURES.map((f) => f.fr), ...FIXTURES.map((f) => f.en), ...INTENTS.map((i) => INTENT_DESCRIPTIONS[i])];
    const res = await fetch(`${emb.url}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "bge-m3-int8-ov", input: texts }),
    });
    if (!res.ok) throw new Error(`embeddings HTTP ${res.status} : ${await res.text()}`);
    const vs = readEmbeddings(await res.json()).map((v) => Array.from(v));
    if (vs.length !== texts.length) throw new Error("réponse d'embeddings incomplète");
    const device = emb.metrics().device;
    if (Object.values(device).some((d) => d === "CPU")) throw new Error(`embedding sur CPU : ${JSON.stringify(device)}`);
    const n = FIXTURES.length;
    const out: BgeVectors = {
      device,
      fr: vs.slice(0, n),
      en: vs.slice(n, 2 * n),
      desc: Object.fromEntries(INTENTS.map((i, k) => [i, vs[2 * n + k]!])),
    };
    mkdirSync(dirname(BGE_FILE), { recursive: true });
    writeFileSync(BGE_FILE, JSON.stringify(out));
    console.log(`[q16-embed] ${vs.length} vecteurs, périphériques ${JSON.stringify(device)} → ${BGE_FILE}`);
  } finally {
    await stop(started);
    await cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
