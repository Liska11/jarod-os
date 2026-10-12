// Portage verbatim de packages/core/src/services/auto-improvement-config.ts (rév. 2e180305).
/**
 * Les réglages de l'auto-amélioration (`services/auto-improvement.ts`).
 *
 * Ce fichier n'importe RIEN : `settings.ts` en tire la valeur par défaut, et un import dans l'autre
 * sens ferait un cycle au chargement. Tout ce qui arrive ici — d'un écran, d'un fichier JSON ou d'un
 * bundle — passe par `normalizeAutoImprovementConfig` : une valeur absurde est ramenée dans ses
 * bornes plutôt que transmise, et une liste mal typée redevient une liste de chaînes.
 */

export interface AutoImprovementSchedule {
  /** 0 = dimanche … 6 = samedi, comme `ScheduleSpec` « daily ». */
  day: number;
  /** Heure locale `HH:MM`. */
  time: string;
}

export interface AutoImprovementConfig {
  /** La passe hebdomadaire. Éteinte par défaut : elle consomme du quota GitHub et, si demandé, un modèle. */
  enabled: boolean;
  schedule: AutoImprovementSchedule;
  /** Une recherche de dépôts par mot-clé (le budget `maxQueries` tranche s'il y en a trop). */
  keywords: string[];
  /** Une recherche de dépôts par sujet GitHub (`topic:`). */
  topics: string[];
  /** Langages acceptés (minuscules, comme GitHub les nomme). Vide : tous. */
  languages: string[];
  minStars: number;
  /** Un dépôt sans mise à jour depuis ce délai est écarté. */
  updatedWithinDays: number;
  /** Licences acceptées (identifiants SPDX en minuscules : mit, apache-2.0…). Vide : toutes. */
  licenses: string[];
  /** Dépôts suivis de près : leurs PR fusionnées et leurs tickets les plus demandés sont lus. */
  watchRepos: string[];
  /** Jamais proposés (le dépôt de Jarod-One lui-même, des miroirs…). */
  excludeRepos: string[];
  /** Le dépôt GitHub de Jarod-One, s'il en a un : ses tickets ouverts nourrissent l'auto-analyse. */
  ownRepo: string;
  /** Le dossier des sources à analyser. Vide : l'espace de travail ou le dossier courant, s'ils en sont. */
  sourceDir: string;
  /**
   * Ce que Jarod-One EST, en mots : la pertinence d'une découverte se mesure à ces termes. C'est le
   * « manifeste » — modifiable, parce que ce qui compte pour ce projet change avec lui.
   */
  manifest: string[];
  /** Score minimal (0 à 100) pour qu'une découverte figure au rapport. */
  minScore: number;
  maxResults: number;
  /** Plafond des appels à l'API de recherche par passe (elle en tolère 30 par minute). */
  maxQueries: number;
  /** Lire les tickets les plus demandés des dépôts suivis. */
  searchIssues: boolean;
  /** Une synthèse rédigée par le modèle actif. Seuls des titres et des chiffres lui sont envoyés, jamais du code. */
  useLlm: boolean;
  /** État : prochaine passe planifiée (ms), 0 = pas encore calculée. */
  nextRunAt: number;
  /** État : dernière passe terminée (ms), 0 = jamais. */
  lastRunAt: number;
}

export const DEFAULT_AUTO_IMPROVEMENT: AutoImprovementConfig = {
  enabled: false,
  schedule: { day: 1, time: "09:00" },
  keywords: ["ai agent desktop", "mcp server", "coding agent", "llm tool calling", "local rag sqlite"],
  topics: ["ai-agent", "model-context-protocol", "electron"],
  languages: ["typescript", "javascript"],
  minStars: 50,
  updatedWithinDays: 180,
  licenses: [],
  watchRepos: [],
  excludeRepos: [],
  ownRepo: "",
  sourceDir: "",
  manifest: [
    "agent",
    "llm",
    "mcp",
    "electron",
    "desktop",
    "rag",
    "sqlite",
    "fts5",
    "embedding",
    "tool",
    "coding",
    "scheduler",
    "workflow",
    "memory",
    "skills",
    "telegram",
    "local",
    "llama.cpp",
    "ollama",
    "sandbox",
    "typescript",
    "react",
  ],
  minScore: 50,
  maxResults: 25,
  maxQueries: 12,
  searchIssues: true,
  useLlm: true,
  nextRunAt: 0,
  lastRunAt: 0,
};

const SLUG = /^[\w.-]+\/[\w.-]+$/;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Une liste de chaînes propres, sans doublon, bornée. Une chaîne seule est découpée aux virgules. */
function words(value: unknown, fallback: string[], lower = false, max = 40): string[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!raw) return [...fallback];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const clean = (lower ? item.toLowerCase() : item).trim().replace(/\s+/g, " ").slice(0, 100);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, max);
}

/** « https://github.com/o/r.git » comme « o/r » ; le reste est écarté, pas deviné. */
export function repoSlug(value: string): string | null {
  const clean = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return SLUG.test(clean) ? clean : null;
}

function slugs(value: unknown, fallback: string[]): string[] {
  return words(value, fallback)
    .map(repoSlug)
    .filter((s): s is string => s !== null);
}

function schedule(value: unknown): AutoImprovementSchedule {
  const v = (value && typeof value === "object" ? value : {}) as Partial<AutoImprovementSchedule>;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v.time ?? ""));
  const time =
    m && Number(m[1]) <= 23 && Number(m[2]) <= 59
      ? `${m[1]!.padStart(2, "0")}:${m[2]}`
      : DEFAULT_AUTO_IMPROVEMENT.schedule.time;
  return { day: clamp(v.day, 0, 6, DEFAULT_AUTO_IMPROVEMENT.schedule.day), time };
}

/**
 * Ramène n'importe quelle entrée à une configuration valide. `base` fournit ce que l'entrée ne dit
 * pas : un patch partiel garde donc le reste tel qu'il était.
 */
export function normalizeAutoImprovementConfig(
  input: unknown,
  base: AutoImprovementConfig = DEFAULT_AUTO_IMPROVEMENT,
): AutoImprovementConfig {
  const v = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const has = (k: keyof AutoImprovementConfig) => k in v && v[k] !== undefined;
  const bool = (k: keyof AutoImprovementConfig) => (has(k) ? v[k] === true : (base[k] as boolean));
  return {
    enabled: bool("enabled"),
    schedule: has("schedule") ? schedule(v.schedule) : { ...base.schedule },
    keywords: has("keywords") ? words(v.keywords, base.keywords) : [...base.keywords],
    topics: has("topics") ? words(v.topics, base.topics, true) : [...base.topics],
    languages: has("languages") ? words(v.languages, base.languages, true) : [...base.languages],
    minStars: has("minStars") ? clamp(v.minStars, 0, 1_000_000, base.minStars) : base.minStars,
    updatedWithinDays: has("updatedWithinDays")
      ? clamp(v.updatedWithinDays, 1, 3650, base.updatedWithinDays)
      : base.updatedWithinDays,
    licenses: has("licenses") ? words(v.licenses, base.licenses, true) : [...base.licenses],
    watchRepos: has("watchRepos") ? slugs(v.watchRepos, base.watchRepos) : [...base.watchRepos],
    excludeRepos: has("excludeRepos") ? slugs(v.excludeRepos, base.excludeRepos) : [...base.excludeRepos],
    ownRepo: has("ownRepo") ? (repoSlug(String(v.ownRepo)) ?? "") : base.ownRepo,
    sourceDir: has("sourceDir") ? String(v.sourceDir).trim().slice(0, 1000) : base.sourceDir,
    manifest: has("manifest") ? words(v.manifest, base.manifest, true, 80) : [...base.manifest],
    minScore: has("minScore") ? clamp(v.minScore, 0, 100, base.minScore) : base.minScore,
    maxResults: has("maxResults") ? clamp(v.maxResults, 1, 100, base.maxResults) : base.maxResults,
    maxQueries: has("maxQueries") ? clamp(v.maxQueries, 1, 30, base.maxQueries) : base.maxQueries,
    searchIssues: bool("searchIssues"),
    useLlm: bool("useLlm"),
    nextRunAt: has("nextRunAt") ? clamp(v.nextRunAt, 0, Number.MAX_SAFE_INTEGER, 0) : base.nextRunAt,
    lastRunAt: has("lastRunAt") ? clamp(v.lastRunAt, 0, Number.MAX_SAFE_INTEGER, 0) : base.lastRunAt,
  };
}
