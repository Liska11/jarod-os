/**
 * GATE reranker — contention sur le CHAT (SPECS-P5-RERANKER.md §8 d, barres figées dans DECISIONS 2026-10-01 : « dictée et chat dégradés de
 * ≤ 10 % pendant un rerank (garde 5 %), barre de la gate P4 »). Même mesure et MÊME verdict que `p4-npu.test.ts` (`npuVerdict`, seuils 10 %
 * et garde 5 % inchangés), avec une autre charge : le worker du reranker (bge-reranker-v2-m3 INT8, IR figée 8×512, NPU d'abord) classe en
 * boucle 16 candidats FACTICES pendant toute la série « sous charge ».
 *
 * Mesure, rien de simulé : vrai llama-server :8080 tel que lancé, prompt fixe, `cache_prompt: false`, 64 tokens, temps lus dans `timings`
 * de llama-server ; trois séries (à vide, sous charge, à vide). Écart > 5 % entre les deux séries à vide = mesure INVALIDE (ignorée avec la
 * raison, à relancer), jamais un échec. Le reranker doit avoir réellement servi (appareil rapporté, ≥ 10 reclassements pendant la série).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_IDLE_DRIFT, MAX_SLOWDOWN, npuVerdict } from "./p4-npu-verdict.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RR_MODEL = join(ROOT, "tools", "ov-bge-reranker-int8-b8x512");
const LLAMA = "http://127.0.0.1:8080";
/**
 * 24 requêtes par série et non 8 comme la gate P4 « déport NPU » : un reclassement de 16 candidats dure ≈ 3 s, une série de 8 requêtes ≈ 20 s ne laisse
 * que ≈ 6 reclassements (première tentative du 2026-10-01 : 6 < 10, condition de validité non atteinte, dégradation observée 0,3 % / 1,1 %). Les seuils
 * (10 %, garde 5 %) et la condition (≥ 10 reclassements) sont INCHANGÉS.
 */
const RUNS = 24;
const PROMPT =
  "Explique en un paragraphe pourquoi un accélérateur dédié aux réseaux de neurones peut soulager le processeur et la carte graphique d'un ordinateur portable pendant qu'un assistant vocal fonctionne.";
const VERDICT_FILE = join(ROOT, ".work", "gate-rerank-chat-verdict.json");

const report: string[] = [];
const log = (l: string) => {
  report.push(l);
  console.log(`[gate-rerank-chat] ${l}`);
};
afterAll(async () => {
  mkdirSync(join(ROOT, ".work"), { recursive: true });
  writeFileSync(join(ROOT, ".work", `gate-rerank-chat-report-${Date.now()}.txt`), `${report.join("\n")}\n`);
  await cleanup();
});

interface Timing {
  promptMs: number;
  promptPerSecond: number;
  predictedPerSecond: number;
}
async function chatOnce(model: string): Promise<Timing> {
  const res = await fetch(`${LLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: PROMPT }], max_tokens: 64, temperature: 0, seed: 1, cache_prompt: false, stream: false }),
  });
  expect(res.ok, `llama-server ${res.status}`).toBe(true);
  const t = ((await res.json()) as { timings: { prompt_ms: number; prompt_per_second: number; predicted_per_second: number } }).timings;
  return { promptMs: t.prompt_ms, promptPerSecond: t.prompt_per_second, predictedPerSecond: t.predicted_per_second };
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
async function series(label: string, model: string) {
  const runs: Timing[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await chatOnce(model));
  const s = { promptMs: median(runs.map((r) => r.promptMs)), promptPerSecond: median(runs.map((r) => r.promptPerSecond)), predictedPerSecond: median(runs.map((r) => r.predictedPerSecond)) };
  log(`${label} : médianes sur ${RUNS} — prompt ${s.promptMs.toFixed(0)} ms (${s.promptPerSecond.toFixed(1)} tok/s), génération ${s.predictedPerSecond.toFixed(2)} tok/s ; génération par requête ${JSON.stringify(runs.map((r) => Number(r.predictedPerSecond.toFixed(2))))}`);
  return s;
}

const TOPICS = ["le réseau de transport", "la planification des travaux", "la supervision des alarmes", "la recette de cuisine", "l'entretien des équipements", "le calendrier des congés", "la sécurité des accès", "la météo de la semaine"];
const sixteen = () => Array.from({ length: 16 }, (_, i) => ({ id: i, text: `Note numéro ${i} : ce paragraphe générique décrit ${TOPICS[i % TOPICS.length]} sans rapport avec une question précise, et sert de charge de test.` }));

describe("GATE reranker — le reclassement sur le NPU ne ralentit pas le chat", () => {
  it("chat llama-server à vide / pendant des reclassements en boucle / à vide", { timeout: 1_800_000 }, async ({ skip }) => {
    expect(existsSync(join(RR_MODEL, "openvino_model.xml")), `IR figée absente : ${RR_MODEL}`).toBe(true);
    const models = (await (await fetch(`${LLAMA}/v1/models`, { signal: AbortSignal.timeout(5000) })).json()) as { data: { id: string }[] };
    const model = models.data[0]!.id;
    log(`llama-server ${LLAMA} : modèle ${model}`);

    // Les drapeaux se posent AVANT le démarrage du plugin (il les lit au démarrage).
    const dataDir = tempDir();
    {
      const first = new JarodApp({ plugins: { storage: { dataDir, keyStores: [memoryKeyStore()], encryptDb: false } } } as never);
      const st = await start(first);
      const s = (first as unknown as { storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } } }).storage.settings;
      s.set("rag", { ...s.get("rag"), enabled: true });
      s.set("ecosystem", { ...s.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: 16, rerankDeadlineMs: 4000, rerankMode: "shadow" });
      await stop(st);
    }
    const app = new JarodApp({ plugins: { storage: { dataDir, keyStores: [memoryKeyStore()], encryptDb: false }, embeddings: { reranker: { modelDir: RR_MODEL, port: 8930, batch: 8, maxLength: 512 } } } } as never);
    const started = await start(app);
    const k = app as unknown as { reranker: { available: boolean; info(): { device?: string }; rerank(r: { query: string; candidates: { id: number; text: string }[]; topN: number; deadlineMs: number }): Promise<unknown> } };
    const t0 = Date.now();
    while (!k.reranker.available && Date.now() - t0 < 360_000) await new Promise((r) => setTimeout(r, 500));
    expect(k.reranker.available, "le reranker n'est pas devenu disponible en 360 s").toBe(true);
    const device = k.reranker.info().device;
    log(`reranker prêt en ${Date.now() - t0} ms sur ${device}`);
    await chatOnce(model);

    const idle1 = await series("à vide (1)", model);
    let running = true;
    let done = 0;
    let failed = 0;
    const load = (async () => {
      while (running) {
        try {
          await k.reranker.rerank({ query: "Quelle est la procédure de supervision des alarmes du réseau ?", candidates: sixteen(), topN: 16, deadlineMs: 4000 });
          done++;
        } catch {
          failed++;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    })();
    const loaded = await series("pendant des reclassements en boucle", model);
    running = false;
    await load;
    log(`charge : ${done} reclassements de 16 candidats réussis, ${failed} échecs, appareil ${device}`);
    const idle2 = await series("à vide (2)", model);

    const v = npuVerdict(idle1, loaded, idle2);
    const p = (x: number) => `${(x * 100).toFixed(1)} %`;
    log(`dégradation sous charge : génération ${p(v.genSlowdown)}, prompt ${p(v.promptSlowdown)} — seuil ${p(MAX_SLOWDOWN)} ; écart à vide : génération ${p(v.genDrift)}, prompt ${p(v.promptDrift)} — garde ${p(MAX_IDLE_DRIFT)}`);
    await stop(started);

    expect(done, "la charge n'a pas réellement tourné").toBeGreaterThanOrEqual(10);
    expect(failed).toBe(0);
    writeFileSync(VERDICT_FILE, JSON.stringify({ at: Date.now(), model, device, reranks: done, idle1, loaded, idle2, ...v }, null, 2));
    if (v.verdict === "invalide") {
      log(`MESURE INVALIDE — à relancer (jamais comptée en échec) : ${v.reasons.join(" ; ")}`);
      skip(`mesure invalide, à relancer : ${v.reasons.join(" ; ")}`);
    }
    expect(v.reasons, v.reasons.join(" ; ")).toEqual([]);
    expect(v.verdict).toBe("verte");
    log("GATE reranker (chat) : verte");
  });
});
