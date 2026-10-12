/**
 * SUIVI de la marge de latence du reranker (DECISIONS 2026-10-01, consigne de l'utilisateur : « ne perds pas la mesure » quand le test e2e a
 * cessé de juger la latence). La p95 mesurée par la gate (b) était de 3,2 s pour une échéance de service de 4 s : 0,8 s de marge, qui
 * disparaît sans bruit au premier changement de modèle, de lot, de pilote ou de machine.
 *
 * Mesure, rien de simulé : le vrai worker isolé (IR figée 8×512, NPU d'abord), 16 candidats FACTICES, 30 reclassements d'affilée après
 * le démarrage à froid, durées relevées côté appelant. Tolérance LARGE, choisie ici (la consigne était « tolérance large », pas un nombre) :
 * échec seulement si la p95 dépasse 90 % de l'échéance de service (3,6 s sur 4 s) ou si un seul reclassement échoue ; en dessous la marge
 * restante est imprimée, jamais jugée. Le fichier `.work/gate-rerank-margin.json` garde la mesure datée pour comparer d'une fois à l'autre.
 * À relancer : changement de modèle / d'IR / de lot / de longueur, mise à jour du pilote NPU ou d'OpenVINO, autre machine.
 *   cd tests && ../node_modules/.bin/vitest run gates/p5-rerank-margin.test.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JarodApp, start, stop } from "@jarod/kernel";
import { cleanup, tempDir } from "@jarod/kernel/testing";
import { memoryKeyStore } from "@jarod/plugin-storage";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RR_MODEL = join(ROOT, "tools", "ov-bge-reranker-int8-b8x512");
const DEADLINE_MS = 4000;
const MAX_P95_SHARE = 0.9;
const RUNS = 30;
afterAll(cleanup);

const TOPICS = ["le réseau de transport", "la planification des travaux", "la supervision des alarmes", "la recette de cuisine", "l'entretien des équipements", "le calendrier des congés", "la sécurité des accès", "la météo de la semaine"];
const sixteen = () => Array.from({ length: 16 }, (_, i) => ({ id: i, text: `Note numéro ${i} : ce paragraphe générique décrit ${TOPICS[i % TOPICS.length]} sans rapport avec une question précise, et sert de charge de test.` }));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]!;

describe("marge de latence du reranker (16 candidats, échéance de service 4 s)", () => {
  it("p95 ≤ 90 % de l'échéance, aucun échec ; la marge restante est imprimée", { timeout: 900_000 }, async () => {
    expect(existsSync(join(RR_MODEL, "openvino_model.xml")), `IR figée absente : ${RR_MODEL}`).toBe(true);
    const dataDir = tempDir();
    {
      const first = new JarodApp({ plugins: { storage: { dataDir, keyStores: [memoryKeyStore()], encryptDb: false } } } as never);
      const st = await start(first);
      const s = (first as unknown as { storage: { settings: { get(k: string): Record<string, unknown>; set(k: string, v: unknown): void } } }).storage.settings;
      s.set("rag", { ...s.get("rag"), enabled: true });
      s.set("ecosystem", { ...s.get("ecosystem"), reranker: "bge-reranker-v2-m3-npu", rerankTopN: 16, rerankDeadlineMs: DEADLINE_MS, rerankMode: "shadow" });
      await stop(st);
    }
    const app = new JarodApp({ plugins: { storage: { dataDir, keyStores: [memoryKeyStore()], encryptDb: false }, embeddings: { reranker: { modelDir: RR_MODEL, port: 8931, batch: 8, maxLength: 512 } } } } as never);
    const started = await start(app);
    const k = app as unknown as { reranker: { available: boolean; info(): { device?: string }; rerank(r: { query: string; candidates: { id: number; text: string }[]; topN: number; deadlineMs: number }): Promise<unknown> } };
    try {
      const t0 = Date.now();
      while (!k.reranker.available && Date.now() - t0 < 360_000) await new Promise((r) => setTimeout(r, 500));
      expect(k.reranker.available, "le reranker n'est pas devenu disponible en 360 s").toBe(true);
      const device = k.reranker.info().device ?? "?";
      const coldMs = Date.now() - t0;
      const ms: number[] = [];
      let failed = 0;
      for (let i = 0; i < RUNS; i++) {
        const t = Date.now();
        try {
          await k.reranker.rerank({ query: "Quelle est la procédure de supervision des alarmes du réseau ?", candidates: sixteen(), topN: 16, deadlineMs: DEADLINE_MS });
          ms.push(Date.now() - t);
        } catch {
          failed++;
        }
      }
      const p50 = pct(ms, 0.5);
      const p95 = pct(ms, 0.95);
      const max = Math.max(...ms);
      const margin = DEADLINE_MS - p95;
      console.log(`[gate-rerank-margin] ${device}, démarrage à froid ${coldMs} ms ; ${ms.length}/${RUNS} réussis, ${failed} échec(s) ; p50 ${p50} ms, p95 ${p95} ms, max ${max} ms ; marge sous l'échéance de ${DEADLINE_MS} ms : ${margin} ms (${((margin / DEADLINE_MS) * 100).toFixed(0)} %) ; limite jugée : p95 ≤ ${DEADLINE_MS * MAX_P95_SHARE} ms`);
      mkdirSync(join(ROOT, ".work"), { recursive: true });
      writeFileSync(join(ROOT, ".work", "gate-rerank-margin.json"), JSON.stringify({ at: Date.now(), device, coldMs, runs: RUNS, failed, p50, p95, max, marginMs: margin, deadlineMs: DEADLINE_MS, ms }, null, 1));
      expect(failed, "un reclassement a échoué").toBe(0);
      expect(p95, `p95 ${p95} ms au-delà de ${MAX_P95_SHARE * 100} % de l'échéance (${DEADLINE_MS * MAX_P95_SHARE} ms)`).toBeLessThanOrEqual(DEADLINE_MS * MAX_P95_SHARE);
    } finally {
      await stop(started);
    }
  });
});
