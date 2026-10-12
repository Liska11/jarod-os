/**
 * Serveur d'embeddings SÉPARÉ du banc de contention voix, mode « dans l'application » (SPECS-P5-VOIX-PRIORITAIRE.md §7) :
 * bge-m3 INT8 sur OpenVINO, comme en production où le noyau parle à un serveur d'embeddings par URL. Le calcul lourd (iGPU/NPU)
 * est ici ; le pilote d'ingestion (lecture des documents, découpage, requêtes, priorité de la voix) est dans l'application.
 * Protocole sur stdout : {"event":"ready","url":"http://127.0.0.1:<port>/v1"} une fois les formes d'embedding compilées ;
 * s'arrête quand le fichier passé en argument existe. Usage : tsx bench/voice-contention-embeddings.ts <fichier d'arrêt>
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const stopFile = process.argv[2];
if (!stopFile) throw new Error("usage : voice-contention-embeddings.ts <fichier d'arrêt>");

const plugins: Record<string, Record<string, unknown>> = {};
for (const p of discoverPlugins()) plugins[p.name] = {};
plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
plugins.scheduler = { autoStart: false };
plugins.agent = { runtimeLock: false };
plugins.embeddings = { modelDir: MODEL, port: 0 };
const app = new JarodApp({ plugins });
const started = await start(app);
const url = (app as unknown as { embeddings: { url: string } }).embeddings.url;

// Chauffe hors mesure : forme courte (128) et forme longue (512).
const post = (input: string[]) => fetch(`${url}/embeddings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, model: "bge-m3-int8-ov" }) }).then((r) => r.ok || Promise.reject(new Error(`embeddings ${r.status}`)));
// L'affectation des formes (128 / 512) au NPU ou à l'iGPU dépend de l'ORDRE de chauffe (constaté). `long-first` (DÉFAUT) reproduit la chauffe de la
// charge d'origine (un texte long d'abord) ; `short-first` compile la forme courte d'abord (essai : la contention y est de +9,5 % seulement).
const short = () => post(["Chauffe du serveur d'embeddings."]);
const long = () => post(["Chauffe d'une forme longue du serveur d'embeddings. ".repeat(60)]);
if (process.env.VC_EMB_WARM !== "short-first") {
  await long();
  await short();
} else {
  await short();
  await long();
}
console.log(JSON.stringify({ event: "ready", url }));

while (!existsSync(stopFile)) await new Promise((r) => setTimeout(r, 300));
// Appareils réellement utilisés par forme d'embedding (128 / 512) : l'affectation dépend de l'ordre de chauffe — à connaître pour interpréter la contention.
const m = (app as unknown as { embeddings: { metrics(): { device: Record<string, string>; texts: number; p95Ms: number } } }).embeddings.metrics();
writeFileSync(`${stopFile}.metrics.json`, JSON.stringify({ device: m.device, texts: m.texts, p95Ms: m.p95Ms }));
await stop(started);
process.exit(0);
