/**
 * GATE P5 — contention de l'ingestion de documents (PDF/Office) sur le chat. Critères FIGÉS avant toute mesure
 * (DECISIONS 2026-09-30 « Contention de l'ingestion de documents … »). Méthode, seuils et verdict = gate P4 « déport NPU »
 * (`p4-npu.test.ts`, `p4-npu-verdict.ts`), sans changement : dégradation ≤ 10 % (génération ET prompt), écart à vide > 5 % =
 * mesure INVALIDE (ignorée avec la raison, jamais un échec).
 *
 * Charge : `RagService.indexDocument` en boucle continue sur des documents RÉELS du corpus (`scripts/corpus/`, ignoré par Git),
 * lus par les VRAIS workers (Docling pour Office, pdfium pour PDF), puis découpés et embarqués par le vrai serveur OpenVINO.
 * Ignoré sans le corpus, le venv, le modèle ou llama-server.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { RagService } from "@jarod/plugin-rag";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_IDLE_DRIFT, MAX_SLOWDOWN, npuVerdict } from "./p4-npu-verdict.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const CORPUS = join(ROOT, "scripts", "corpus");
const PYTHON = join(ROOT, "tools", "docling-venv", "Scripts", "python.exe");
const DOCLING = join(ROOT, "sidecars", "docling-worker", "docling-worker.py");
const PDFIUM = join(ROOT, "sidecars", "pdfium-worker", "pdfium-worker.py");
const VERDICT_FILE = join(ROOT, ".work", "gate-p5-docs-verdict.json");
const LLAMA = "http://127.0.0.1:8080";
const RUNS = 8;
const FORMATS = new Set([".pdf", ".docx", ".pptx", ".xlsx"]);
const MAX_DOC_BYTES = 7 * 1024 * 1024;
const PROMPT =
  "Explique en un paragraphe pourquoi un accélérateur dédié aux réseaux de neurones peut soulager le processeur et la carte graphique d'un ordinateur portable pendant qu'un assistant vocal fonctionne.";

const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[gate-p5-docs] ${l}`);
};

afterAll(async () => {
  mkdirSync(join(ROOT, ".work"), { recursive: true });
  writeFileSync(join(ROOT, ".work", `gate-p5-docs-report-${Date.now()}.txt`), `${report.join("\n")}\n`);
  await cleanup();
});

/** Documents de la charge : formats de Q-I3, ≤ 7 Mio, ordre déterministe ; aucun nom n'est journalisé (identifiants D01…). */
const documents = (): string[] =>
  existsSync(CORPUS)
    ? readdirSync(CORPUS)
        .filter((f) => FORMATS.has(extname(f).toLowerCase()) && statSync(join(CORPUS, f)).size <= MAX_DOC_BYTES)
        .sort((a, b) => a.localeCompare(b))
        .map((f) => join(CORPUS, f))
    : [];

const HAVE = existsSync(MODEL) && existsSync(PYTHON) && existsSync(DOCLING) && existsSync(PDFIUM) && documents().length > 0;

async function llamaUp(): Promise<boolean> {
  try {
    return (await fetch(`${LLAMA}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

interface Timing {
  promptMs: number;
  promptPerSecond: number;
  predictedPerSecond: number;
  predicted: number;
}

async function chatOnce(model: string): Promise<Timing> {
  const res = await fetch(`${LLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: PROMPT }], max_tokens: 64, temperature: 0, seed: 1, cache_prompt: false, stream: false }),
  });
  expect(res.ok, `llama-server ${res.status}`).toBe(true);
  const t = ((await res.json()) as { timings: { prompt_ms: number; prompt_per_second: number; predicted_per_second: number; predicted_n: number } }).timings;
  return { promptMs: t.prompt_ms, promptPerSecond: t.prompt_per_second, predictedPerSecond: t.predicted_per_second, predicted: t.predicted_n };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function series(label: string, model: string) {
  const runs: Timing[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await chatOnce(model));
  const s = {
    promptMs: median(runs.map((r) => r.promptMs)),
    promptPerSecond: median(runs.map((r) => r.promptPerSecond)),
    predictedPerSecond: median(runs.map((r) => r.predictedPerSecond)),
  };
  log(`${label} : médianes sur ${RUNS} — prompt ${s.promptMs.toFixed(0)} ms (${s.promptPerSecond.toFixed(1)} tok/s), génération ${s.predictedPerSecond.toFixed(2)} tok/s`);
  return s;
}

describe("GATE P5 — l'ingestion de documents PDF/Office ne ralentit pas le chat", () => {
  it("chat llama-server à vide / sous ingestion de documents réels / à vide", { timeout: 2_400_000 }, async ({ skip }) => {
    if (!HAVE) skip("corpus, venv Docling, modèle d'embeddings ou workers absents");
    if (!(await llamaUp())) skip("llama-server :8080 absent");
    const models = (await (await fetch(`${LLAMA}/v1/models`, { signal: AbortSignal.timeout(5000) })).json()) as { data: { id: string }[] };
    const model = models.data[0]!.id;
    const docs = documents();
    log(`llama-server ${LLAMA} : modèle ${model} ; ${docs.length} documents dans la charge`);

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
      embeddings: { url: string; metrics(): EmbeddingsMetrics };
    };
    const { db, settings } = k.storage;
    settings.set("rag", { ...settings.get("rag"), enabled: true, embeddingsUrl: k.embeddings.url, embeddingsModel: "bge-m3-int8-ov", doclingPython: PYTHON, doclingWorker: DOCLING, pdfiumWorker: PDFIUM });
    settings.set("ecosystem", { ...settings.get("ecosystem"), documentParser: "docling" });
    // Le drapeau est lu à la construction : un service construit APRÈS les réglages, avec les workers.
    const rag = new RagService({ db, settings, providers: k.llm.providers });

    // Compilation des formes d'embedding et démarrage des workers hors mesure (un court texte ; un petit PDF).
    await rag.ingest("Chauffe du serveur d'embeddings avant la mesure. ".repeat(40), { docId: "chauffe", source: "chauffe" });
    // Démarrage à froid des DEUX workers hors mesure (imports de Docling, chargement de pdfium) : un document par format.
    for (const ext of [".xlsx", ".pdf", ".pptx", ".docx"]) {
      const first = docs.find((d) => extname(d).toLowerCase() === ext);
      if (!first) continue;
      const t1 = Date.now();
      await rag.indexDocument(first, `chauffe-worker${ext}`);
      log(`chauffe ${ext} (à vide) : ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    }
    await chatOnce(model);

    const idle1 = await series("à vide (1)", model);

    let running = true;
    let read = 0;
    let chunks = 0;
    const refused: string[] = [];
    const load = (async () => {
      for (let i = 0; running; i++) {
        const path = docs[i % docs.length]!;
        try {
          // Identifiant varié à chaque tour : rien n'est dédupliqué, chaque tour relit, redécoupe et réembarque.
          const t1 = Date.now();
          const r = await rag.indexDocument(path, `charge-${i}${extname(path)}`);
          read++;
          chunks += r.chunks;
          log(`  document ${i % docs.length + 1}/${docs.length} (${extname(path)}) : ${r.chunks} chunks en ${((Date.now() - t1) / 1000).toFixed(1)} s`);
        } catch (e) {
          refused.push((e as Error).message.split(": ")[0]!.slice(0, 60));
          log(`  document ${i % docs.length + 1}/${docs.length} (${extname(path)}) : refusé ${refused[refused.length - 1]}`);
        }
      }
    })();
    const t0 = Date.now();
    const loaded = await series("sous ingestion de documents", model);
    running = false;
    await load;
    const loadSeconds = (Date.now() - t0) / 1000;
    log(`charge : ${read} documents lus et indexés (${chunks} chunks, ${(chunks / loadSeconds).toFixed(1)} chunks/s sur ${loadSeconds.toFixed(0)} s) ; refusés : ${refused.length} ${JSON.stringify([...new Set(refused)])}`);

    const idle2 = await series("à vide (2)", model);
    const v = npuVerdict(idle1, loaded, idle2);
    const p = (x: number) => `${(x * 100).toFixed(1)} %`;
    log(`dégradation sous charge : génération ${p(v.genSlowdown)}, prompt ${p(v.promptSlowdown)} — seuil ${p(MAX_SLOWDOWN)} ; écart à vide : génération ${p(v.genDrift)}, prompt ${p(v.promptDrift)} — invalide au-delà de ${p(MAX_IDLE_DRIFT)}`);
    const m = k.embeddings.metrics();
    log(`métriques embeddings : ${JSON.stringify({ device: m.device, texts: m.texts, p95Ms: m.p95Ms })}`);
    await rag.close();
    await stop(started);

    // La charge a réellement tourné, sans repli des workers, sans embedding sur CPU (forme 512 sur NPU refusée ⇒ GPU.0 admis).
    expect(read, "moins de 3 documents lus pendant la série : la charge n'a pas porté").toBeGreaterThanOrEqual(3);
    // Une erreur de DOCUMENT (WORKER_ERROR) est un refus normal ; un échec de PROCESSUS du worker ne l'est pas.
    expect(refused.filter((c) => /WORKER_(EXIT|TIMEOUT|BAD_RESPONSE|SPAWN|MISSING|UNAVAILABLE)/.test(c))).toEqual([]);
    expect(m.attempts.filter((a) => a.ok).every((a) => a.device !== "CPU")).toBe(true);
    expect(Object.values(m.device).every((d) => d !== "CPU")).toBe(true);

    mkdirSync(join(ROOT, ".work"), { recursive: true });
    writeFileSync(VERDICT_FILE, JSON.stringify({ at: Date.now(), model, read, chunks, refused, device: m.device, idle1, loaded, idle2, ...v }, null, 2));
    if (v.verdict === "invalide") {
      log(`MESURE INVALIDE — à relancer (jamais comptée en échec) : ${v.reasons.join(" ; ")}`);
      skip(`mesure invalide, à relancer : ${v.reasons.join(" ; ")}`);
    }
    expect(v.reasons, v.reasons.join(" ; ")).toEqual([]);
    expect(v.verdict).toBe("verte");
    log("GATE P5 contention des documents : verte");
  });
});
