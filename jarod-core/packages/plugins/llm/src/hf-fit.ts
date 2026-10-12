/**
 * Verdict « tient-il ? » d'une entrée d'un dépôt Hugging Face, AVANT tout téléchargement (SPECS-P5-MODELS.md § 3.6 et § 3.10 (c)) : le cache d'analyse d'abord, sinon la
 * lecture `Range` de l'en-tête du PREMIER fragment à la révision épinglée ; le verdict est recalculé pour les options demandées (contexte, type de cache) à partir de
 * l'analyse, avec le poids = SOMME des tailles du jeu. Le verdict est donc le même, que l'analyse vienne du réseau ou du cache.
 *
 * Une panne de transport (429, `Range` ignoré, délai, réseau, annulation) rend « Not checked » avec sa cause et n'est JAMAIS mise en cache ; un en-tête illisible rend
 * « Not estimated » (résultat déterministe, mis en cache). Rien n'est relancé ici : une 429 s'arrête, l'utilisateur relance.
 */
import { type FitReport, type ReportOptions, fitReportFromMetadata, readGgufForFit, unreadableFitReport } from "./gguf-fit.js";
import { GgufRangeError } from "./gguf-range.js";
import { type HfAnalysis, type HfFitCache, type HfFitKey, analysisFromMetadata, metadataFromAnalysis } from "./hf-fit-cache.js";
import type { HfEntry } from "./hf-repo.js";
import type { HuggingFaceService } from "./huggingface.js";

export type CheckFitNotChecked =
  | { state: "not-checked"; code: GgufRangeError["code"] | "INCOMPLETE_SET" | "UNEXPECTED"; reason: string; retryAfterSeconds?: number | null; requests: number; transferredBytes: number };

export type CheckFitOutcome = { state: "checked"; report: FitReport; cached: boolean; requests: number; transferredBytes: number } | CheckFitNotChecked;

export interface CheckFitInput {
  service: HuggingFaceService;
  cache: HfFitCache;
  repo: string;
  /** Commit épinglé (40 hexadécimaux) lu dans la fiche : c'est à cette révision que l'en-tête est lu et que le cache est clé. */
  sha: string;
  entry: HfEntry;
  options: ReportOptions;
  /** Relit même si le cache connaît la clé (« Re-check »). */
  force?: boolean;
  signal?: AbortSignal;
  /** Délai de chaque lecture (20 s par défaut). */
  timeoutMs?: number;
  /** Plafond des octets de corps de CETTE lecture (16 Mio par défaut) : l'appelant qui tient un budget cumulé y met ce qu'il peut encore dépenser. */
  maxBytes?: number;
}

function reportFrom(analysis: HfAnalysis, weightBytes: number, options: ReportOptions): FitReport {
  return analysis.kind === "unreadable" ? unreadableFitReport(analysis.reason, options) : fitReportFromMetadata(metadataFromAnalysis(analysis), weightBytes, options);
}

/** Le verdict d'une entrée DÉJÀ analysée, lu du cache : aucune requête, aucune écriture ; `null` quand la clé n'est pas connue. */
export function cachedFitReport(cache: HfFitCache, repo: string, sha: string, entry: HfEntry, options: ReportOptions): FitReport | null {
  const head = entry.files[0];
  if (!entry.complete || !head) return null;
  const hit = cache.has({ repo, sha, file: head.name, size: head.size }) ? cache.get({ repo, sha, file: head.name, size: head.size }) : null;
  return hit ? reportFrom(hit, entry.totalBytes, options) : null;
}

export async function checkFit(input: CheckFitInput): Promise<CheckFitOutcome> {
  const { entry, options } = input;
  if (!entry.complete || entry.files.length === 0) {
    return { state: "not-checked", code: "INCOMPLETE_SET", reason: `${entry.key} : fragment(s) manquant(s) dans le dépôt (${entry.missing.join(", ")}), jeu non téléchargeable`, requests: 0, transferredBytes: 0 };
  }
  const head = entry.files[0]!; // le verdict lit l'en-tête du PREMIER fragment (§ 3.5)
  const key: HfFitKey = { repo: input.repo, sha: input.sha, file: head.name, size: head.size };
  if (!input.force) {
    const hit = input.cache.get(key);
    if (hit) return { state: "checked", report: reportFrom(hit, entry.totalBytes, options), cached: true, requests: 0, transferredBytes: 0 };
  }
  const source = input.service.rangeSource({ repo: input.repo, revision: input.sha, file: head.name, expectedSize: head.size, signal: input.signal, timeoutMs: input.timeoutMs });
  try {
    const read = await readGgufForFit(source, input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes });
    const analysis: HfAnalysis = "unreadable" in read ? { kind: "unreadable", reason: read.unreadable } : analysisFromMetadata(read.metadata, read.fileBytes);
    input.cache.set(key, analysis);
    return { state: "checked", report: reportFrom(analysis, entry.totalBytes, options), cached: false, requests: source.requests(), transferredBytes: source.transferred() };
  } catch (e) {
    const base = { state: "not-checked" as const, requests: source.requests(), transferredBytes: source.transferred() };
    if (e instanceof GgufRangeError) {
      return { ...base, code: e.code, reason: e.message, ...(e.code === "RATE_LIMITED" ? { retryAfterSeconds: e.retryAfterSeconds ?? null } : {}) };
    }
    return { ...base, code: "UNEXPECTED", reason: (e as Error).message.slice(0, 200) };
  }
}
