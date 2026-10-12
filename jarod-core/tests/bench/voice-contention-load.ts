/**
 * Charge de la contention « documents → voix » (DECISIONS 2026-10-01) : un processus séparé qui indexe en boucle des documents
 * RÉELS du corpus (.xlsx .docx .pdf ≤ 7 Mio) avec les vrais workers et les vrais embeddings (bge-m3 INT8, NPU/GPU).
 * Protocole sur stdout : une ligne JSON par événement — {"event":"ready"} quand tout est chauffé, {"event":"doc","chunks":n,"at":ms}
 * par document indexé, {"event":"stopped","docs":n,"chunks":n}. S'arrête quand le fichier passé en argument existe.
 * Usage : tsx bench/voice-contention-load.ts <fichier d'arrêt>
 * VC_LOAD (diagnostic EXPLORATOIRE, hors protocole figé) : « full » (défaut : workers + embeddings), « embed » (embeddings seuls, textes du dépôt,
 * sans worker) ou « parse » (workers seuls, embeddings factices : aucun calcul sur NPU/GPU).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { tempDir } from "@jarod/kernel/testing";
import { RagService } from "@jarod/plugin-rag";
import { memoryKeyStore } from "@jarod/plugin-storage";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "scripts", "corpus");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const PYTHON = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const DOCLING = join(ROOT, "sidecars", "docling-worker", "docling-worker.py");
const PDFIUM = join(ROOT, "sidecars", "pdfium-worker", "pdfium-worker.py");
const FORMATS = new Set([".xlsx", ".docx", ".pdf"]);
const MODE = process.env.VC_LOAD ?? "full";
const stopFile = process.argv[2];
if (!stopFile) throw new Error("usage : voice-contention-load.ts <fichier d'arrêt>");

const docs = readdirSync(CORPUS)
  .filter((f) => FORMATS.has(extname(f).toLowerCase()) && statSync(join(CORPUS, f)).size <= 7 * 1024 * 1024)
  .sort((a, b) => a.localeCompare(b))
  .map((f) => join(CORPUS, f));
const emit = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

const plugins: Record<string, Record<string, unknown>> = {};
for (const p of discoverPlugins()) plugins[p.name] = {};
plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
plugins.scheduler = { autoStart: false };
plugins.agent = { runtimeLock: false };
plugins.embeddings = { modelDir: MODEL, port: 0 };
const app = new JarodApp({ plugins });
const started = await start(app);
const k = app as unknown as {
  storage: { db: import("@jarod/plugin-storage").Db; settings: import("@jarod/plugin-storage").SettingsService };
  llm: { providers: ConstructorParameters<typeof RagService>[0]["providers"] };
  embeddings: { url: string };
};
const { db, settings } = k.storage;
settings.set("rag", { ...settings.get("rag"), enabled: true, embeddingsUrl: k.embeddings.url, embeddingsModel: "bge-m3-int8-ov", doclingPython: PYTHON, doclingWorker: DOCLING, pdfiumWorker: PDFIUM });
settings.set("ecosystem", { ...settings.get("ecosystem"), documentParser: "docling" });
const rag = new RagService({ db, settings, providers: k.llm.providers });

if (MODE === "parse") rag.setEmbedder(async (texts) => texts.map(() => Float32Array.from([1, 0, 0, 0]))); // aucun calcul d'embedding
// Chauffe hors mesure : formes d'embedding et un document par format.
if (MODE !== "parse") await rag.ingest("Chauffe du serveur d'embeddings avant la mesure. ".repeat(40), { docId: "chauffe", source: "chauffe" });
if (MODE !== "embed") {
  for (const ext of [".xlsx", ".docx", ".pdf"]) {
    const first = docs.find((d) => extname(d).toLowerCase() === ext);
    if (first) await rag.indexDocument(first, `chauffe${ext}`);
  }
}
// Textes du dépôt en tranches de 3 200 caractères (4 chunks de 800) : charge d'embeddings pure, comme la gate P4 « chunks longs ».
const texts: string[] = [];
for (const f of ["plan.md", "PHASE-2.md", "PHASE-3.md"]) {
  const t = readFileSync(join(ROOT, f), "utf8");
  for (let i = 0; i + 3200 <= t.length; i += 3200) texts.push(t.slice(i, i + 3200));
}
emit({ event: "ready", docs: docs.length, mode: MODE });

let n = 0;
let chunks = 0;
for (let i = 0; !existsSync(stopFile); i++) {
  if (MODE === "embed") {
    const r = await rag.ingest(`${texts[i % texts.length]!} (${i})`, { docId: `charge-${i}`, source: "charge" });
    n++;
    chunks += r.chunks;
    emit({ event: "doc", chunks: r.chunks, at: Date.now() });
    continue;
  }
  const path = docs[i % docs.length]!;
  try {
    const r = await rag.indexDocument(path, `charge-${i}${extname(path)}`);
    n++;
    chunks += r.chunks;
    emit({ event: "doc", chunks: r.chunks, at: Date.now() });
  } catch (e) {
    emit({ event: "refused", code: (e as Error).message.split(": ")[0]!.slice(0, 60), at: Date.now() });
  }
}
emit({ event: "stopped", docs: n, chunks });
await rag.close();
await stop(started);
process.exit(0);
