/**
 * GATE P4 — déport NPU (PLAN §6 « new : NPU-offload »). La promesse du plan (§4, gap G5) : la charge
 * d'embeddings va sur le NPU et « ne touche ni CPU ni GPU » — le chat (llama-server) ne doit pas ralentir
 * pendant une indexation massive.
 *
 * Mesure, rien de simulé :
 *   - chat : vrai llama-server :8080, prompt fixe, `cache_prompt: false` (le prompt est retraité à chaque
 *     requête), 64 tokens générés ; temps relevés par llama-server lui-même (`timings` : traitement du
 *     prompt, débit de génération) — indépendants de la boucle d'événements de ce processus ;
 *   - charge : `RagService.ingest` en boucle continue (chemin de la gate P2 : HTTP `/v1/embeddings` →
 *     OpenVINO → NPU, bge-m3 INT8), pendant toute la série « sous charge » ;
 *   - trois séries : à vide, sous charge, à vide de nouveau (dérive thermique ou autre = visible).
 * Cible : llama-server TEL QU'IL EST LANCÉ sur cette machine (Defiant-Fable-9B au 2026-09-28), carte non
 * vérifiée — la gate mesure la configuration réelle du serveur, par choix.
 * Critères (validés par l'utilisateur, 2026-09-28 ; `p4-npu-verdict.ts`) : chaque embedding servi par le NPU
 * sans repli ; la charge a réellement tourné ; dégradation ≤ 10 % sur la génération (tok/s qui baissent)
 * ET sur le traitement du prompt (ms qui montent) ; écart > 5 % entre les deux séries à vide = mesure
 * INVALIDE (test ignoré avec la raison, à relancer), jamais un échec.
 * Référence (première mesure, 2026-09-28) : génération 0,4 %, prompt 2,2 %, écart à vide 1,2 %.
 *
 * Deux charges, mêmes seuils :
 *   - « chunks courts » (gate d'origine) : documents P2 (≤ 128 tokens) → forme 128, NPU exigé partout ;
 *   - « chunks longs » (décision (d) du 2026-09-29) : pages réelles du dépôt découpées par `chunkText` aux
 *     réglages par défaut (800 caractères, > 128 tokens) → forme 512, que le NPU refuse
 *     (`infer_request.cpp:246`) et qui tourne sur l'iGPU (GPU.0) : ce repli est ACCEPTÉ ; la gate mesure son
 *     effet réel sur le chat. CPU = rouge ; seul refus toléré : forme 512 sur NPU.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddingsMetrics } from "@jarod/contracts";
import { discoverPlugins, JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterAll, describe, expect, it } from "vitest";
import { DOCS } from "./p2-docs.js";
import { MAX_IDLE_DRIFT, MAX_SLOWDOWN, npuVerdict, VERDICT_FILE, VERDICT_FILE_LONG } from "./p4-npu-verdict.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = join(ROOT, "tools", "ov-bge-m3-int8");
const LLAMA = "http://127.0.0.1:8080";
const RUNS = 8;
const PROMPT =
  "Explique en un paragraphe pourquoi un accélérateur dédié aux réseaux de neurones peut soulager le processeur et la carte graphique d'un ordinateur portable pendant qu'un assistant vocal fonctionne.";

const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[gate-p4-npu] ${l}`);
};

afterAll(async () => {
  mkdirSync(join(ROOT, ".work"), { recursive: true });
  writeFileSync(join(ROOT, ".work", `gate-p4-npu-report-${Date.now()}.txt`), `${report.join("\n")}\n`);
  await cleanup();
});

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
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: PROMPT }],
      max_tokens: 64,
      temperature: 0,
      seed: 1,
      cache_prompt: false,
      stream: false,
    }),
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
  log(
    `${label} : médianes sur ${RUNS} — prompt ${s.promptMs.toFixed(0)} ms (${s.promptPerSecond.toFixed(1)} tok/s), génération ${s.predictedPerSecond.toFixed(2)} tok/s ; génération par requête ${JSON.stringify(runs.map((r) => Number(r.predictedPerSecond.toFixed(2))))}`,
  );
  return s;
}

/** Pages réelles du dépôt, en tranches de ~4 chunks de 800 caractères (un lot de 4 par ingestion). */
function longTexts(): [string, string][] {
  const out: [string, string][] = [];
  for (const f of ["plan.md", "docs/ECOSYSTEME.md", "PHASE-2.md", "PHASE-3.md"]) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (let i = 0; i + 3200 <= text.length; i += 3200) out.push([`${f}@${i}`, text.slice(i, i + 3200)]);
  }
  return out;
}

interface Load {
  name: string;
  verdictFile: string;
  texts: () => [string, string][];
  /** Contrôle des périphériques après la mesure (le déport lui-même : rouge, jamais invalide). */
  devices: (m: EmbeddingsMetrics) => void;
}

const LOADS: Load[] = [
  {
    name: "chunks courts",
    verdictFile: VERDICT_FILE,
    texts: () => DOCS.map(([id, text]) => [id, text]),
    devices: (m) => {
      expect(m.attempts.filter((a) => !a.ok)).toEqual([]);
      expect(m.attempts.every((a) => a.device === "NPU")).toBe(true);
      expect(Object.values(m.device).every((d) => d === "NPU")).toBe(true);
    },
  },
  {
    name: "chunks longs",
    verdictFile: VERDICT_FILE_LONG,
    texts: longTexts,
    devices: (m) => {
      expect(m.device["512"], "forme 512 jamais compilée : la charge n'a pas porté de chunks longs").toBeDefined();
      expect(m.attempts.filter((a) => !a.ok && !(a.shape === 512 && a.device === "NPU"))).toEqual([]);
      expect(m.attempts.filter((a) => a.ok).every((a) => a.device !== "CPU")).toBe(true);
      expect(Object.values(m.device).every((d) => d !== "CPU")).toBe(true);
      if (m.device["128"]) expect(m.device["128"]).toBe("NPU");
    },
  },
];

/**
 * Une charge par processus : le premier kernel garde le NPU après `stop` (constaté le 2026-09-29 — la
 * seconde charge du même processus voit la forme 128 refusée par le NPU et part sur GPU.0). `pnpm gate:p4`
 * lance chaque charge dans son processus (`-t`) ; ici la seconde est ignorée avec la raison, jamais rouge.
 */
let npuUsedInProcess: string | null = null;

describe("GATE P4 — déport NPU : l'indexation sur le NPU ne ralentit pas le chat", () => {
  for (const L of LOADS) {
    it(`${L.name} : chat llama-server à vide / sous charge d'embeddings / à vide`, { timeout: 1_800_000 }, async ({ skip }) => {
      if (npuUsedInProcess) skip(`une charge NPU par processus (« ${npuUsedInProcess} » déjà passée) : lancer avec -t, comme pnpm gate:p4`);
      npuUsedInProcess = L.name;
      expect(existsSync(MODEL), `modèle absent : ${MODEL}`).toBe(true);
      const models = (await (await fetch(`${LLAMA}/v1/models`, { signal: AbortSignal.timeout(5000) })).json()) as { data: { id: string }[] };
      const model = models.data[0]!.id;
      log(`[${L.name}] llama-server ${LLAMA} : modèle ${model}`);
      const texts = L.texts();

      const plugins: Record<string, Record<string, unknown>> = {};
      for (const p of discoverPlugins()) plugins[p.name] = {};
      plugins.storage = { dataDir: tempDir(), keyStores: [memoryKeyStore()] };
      plugins.scheduler = { autoStart: false };
      plugins.agent = { runtimeLock: false };
      plugins.embeddings = { modelDir: MODEL, port: 0 };
      const app = new JarodApp({ plugins });
      const started = await start(app);
      const k = app as unknown as {
        storage: { settings: import("@jarod/plugin-storage").SettingsService };
        rag: { rag: import("@jarod/plugin-rag").RagService };
        embeddings: { url: string; metrics(): EmbeddingsMetrics };
      };
      k.storage.settings.set("rag", {
        ...k.storage.settings.get("rag"),
        enabled: true,
        embeddingsUrl: k.embeddings.url,
        embeddingsModel: "bge-m3-int8-ov",
      });
      // Compilation (et sonde CPU) hors mesure : court = forme 128, long = formes 128 et 512.
      await k.rag.rag.ingest(DOCS[0]![1], { docId: "chauffe", source: "chauffe" });
      if (L.verdictFile === VERDICT_FILE_LONG) await k.rag.rag.ingest(texts[0]![1], { docId: "chauffe-long", source: "chauffe" });
      await chatOnce(model);

      const idle1 = await series("à vide (1)", model);

      let running = true;
      let ingested = 0;
      let chunks = 0;
      const load = (async () => {
        for (let i = 0; running; i++) {
          const [id, text] = texts[i % texts.length]!;
          chunks += (await k.rag.rag.ingest(`${text} (${i})`, { docId: `charge-${id}-${i}`, source: "charge" })).chunks;
          ingested++;
        }
      })();
      const t0 = Date.now();
      const loaded = await series(`sous charge (${L.name})`, model);
      running = false;
      await load;
      const loadSeconds = (Date.now() - t0) / 1000;
      log(`charge : ${ingested} documents, ${chunks} chunks indexés pendant la série (${(chunks / loadSeconds).toFixed(1)} chunks/s sur ${loadSeconds.toFixed(0)} s)`);

      const idle2 = await series("à vide (2)", model);

      const v = npuVerdict(idle1, loaded, idle2);
      const p = (x: number) => `${(x * 100).toFixed(1)} %`;
      log(`dégradation sous charge : génération ${p(v.genSlowdown)} (tok/s en baisse), traitement du prompt ${p(v.promptSlowdown)} (ms en hausse) — seuil ${p(MAX_SLOWDOWN)} ; écart entre les séries à vide : génération ${p(v.genDrift)}, prompt ${p(v.promptDrift)} — garde ${p(MAX_IDLE_DRIFT)}`);

      const m = k.embeddings.metrics();
      log(`métriques embeddings : ${JSON.stringify({ device: m.device, texts: m.texts, p95Ms: m.p95Ms, attempts: m.attempts.map((a) => ({ shape: a.shape, device: a.device, ok: a.ok, ...(a.error ? { error: a.error.slice(0, 160) } : {}) })) })}`);
      await stop(started);

      // Le déport lui-même : la charge a tourné, sur les périphériques admis (sinon rouge, pas invalide).
      expect(ingested).toBeGreaterThanOrEqual(10);
      L.devices(m);

      writeFileSync(L.verdictFile, JSON.stringify({ at: Date.now(), load: L.name, model, ingested, chunks, device: m.device, idle1, loaded, idle2, ...v }, null, 2));
      if (v.verdict === "invalide") {
        log(`MESURE INVALIDE — à relancer (jamais comptée en échec) : ${v.reasons.join(" ; ")}`);
        skip(`mesure invalide, à relancer : ${v.reasons.join(" ; ")}`);
      }
      expect(v.reasons, v.reasons.join(" ; ")).toEqual([]);
      expect(v.verdict).toBe("verte");
      log(`GATE P4 déport NPU (${L.name}) : verte`);
    });
  }
});
