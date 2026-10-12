/**
 * Verdict de la gate P4 « déport NPU » (seuils validés par l'utilisateur, 2026-09-28).
 *
 * Chaque métrique est lue dans SON sens de dégradation :
 *   - génération (tok/s) : dégradée quand elle BAISSE → dégradation = 1 − sous_charge / à_vide ;
 *   - traitement du prompt (ms) : dégradé quand il MONTE → dégradation = sous_charge / à_vide − 1.
 * Une amélioration donne une dégradation négative (jamais un échec). « À vide » = moyenne des deux séries
 * à vide (avant, après). Écart entre ces deux séries > 5 % sur l'une ou l'autre métrique → mesure
 * INVALIDE (à relancer), jamais comptée en échec.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Écrit par la gate, lu par `gates/p4.ts` : « invalide » s'y distingue d'un échec. */
export const VERDICT_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), ".work", "gate-p4-npu-verdict.json");
/** Même verdict, charge de chunks LONGS (forme 512 : GPU.0 accepté, décision (d) du 2026-09-29). */
export const VERDICT_FILE_LONG = join(dirname(VERDICT_FILE), "gate-p4-npu-long-verdict.json");

export const MAX_SLOWDOWN = 0.1;
export const MAX_IDLE_DRIFT = 0.05;

export interface SeriesMedians {
  /** Médiane du temps de traitement du prompt, en ms (plus haut = pire). */
  promptMs: number;
  /** Médiane du débit de génération, en tok/s (plus bas = pire). */
  predictedPerSecond: number;
}

export interface NpuVerdict {
  verdict: "verte" | "rouge" | "invalide";
  genSlowdown: number;
  promptSlowdown: number;
  genDrift: number;
  promptDrift: number;
  reasons: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

export function npuVerdict(idle1: SeriesMedians, loaded: SeriesMedians, idle2: SeriesMedians): NpuVerdict {
  const baseGen = (idle1.predictedPerSecond + idle2.predictedPerSecond) / 2;
  const basePrompt = (idle1.promptMs + idle2.promptMs) / 2;
  const genSlowdown = 1 - loaded.predictedPerSecond / baseGen;
  const promptSlowdown = loaded.promptMs / basePrompt - 1;
  const genDrift = Math.abs(idle1.predictedPerSecond - idle2.predictedPerSecond) / baseGen;
  const promptDrift = Math.abs(idle1.promptMs - idle2.promptMs) / basePrompt;
  const base = { genSlowdown, promptSlowdown, genDrift, promptDrift };

  const invalid: string[] = [];
  if (genDrift > MAX_IDLE_DRIFT) invalid.push(`écart à vide génération ${pct(genDrift)} > ${pct(MAX_IDLE_DRIFT)}`);
  if (promptDrift > MAX_IDLE_DRIFT) invalid.push(`écart à vide prompt ${pct(promptDrift)} > ${pct(MAX_IDLE_DRIFT)}`);
  if (invalid.length) return { verdict: "invalide", ...base, reasons: invalid };

  const red: string[] = [];
  if (genSlowdown > MAX_SLOWDOWN) red.push(`génération ralentie de ${pct(genSlowdown)} > ${pct(MAX_SLOWDOWN)}`);
  if (promptSlowdown > MAX_SLOWDOWN) red.push(`prompt ralenti de ${pct(promptSlowdown)} > ${pct(MAX_SLOWDOWN)}`);
  return { verdict: red.length ? "rouge" : "verte", ...base, reasons: red };
}
