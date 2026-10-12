/**
 * Bibliothèque de modèles et découverte `/models` d'un fournisseur (D1(b)).
 * Sources (rév. 3aaadb0, MIT © github.com/fathah) : `src/main/ipc/register.ts:1837-1850,2669-2693` ;
 * `models.ts:23-56` (`SavedModelRow`/`SavedModel`), `:433-448` (`listModels`) ;
 * `model-discovery.ts:493-512` (`DiscoverModelsResult`), `:514-583` (`discoverProviderModels`) ;
 * `register.ts:1852-1870` + `model-discovery.ts:250-255,306-367,406-429,598-690` (`getModelContextWindow`).
 *
 * Écarts assumés :
 * - la bibliothèque Hermes est un fichier `models.json` tenu à la main ; Jarod a le catalogue de fournisseurs
 *   (`ProviderRouter` : modèles du catalogue ou surcharge `providerOverrides`). Bibliothèque = modèles des
 *   fournisseurs UTILISABLES (clé enregistrée ou local), + le modèle actif s'il n'y figure pas ; identifiant
 *   stable `fournisseur:modèle` ; `createdAt` = 0 (pas de date d'ajout côté Jarod) ;
 * - découverte : clé = celle passée par l'écran, sinon la première clé du coffre (jamais l'environnement) ;
 *   sans clé, seul un fournisseur local est interrogé ; pas de cache (`cached` toujours false) ; fournisseur
 *   inconnu du catalogue sans URL → `unknown-host` ;
 * - fenêtre de contexte : la surcharge manuelle `model.context_length` de `config.yaml` (prioritaire chez Hermes)
 *   n'a pas d'équivalent Jarod → sautée ; les listes Hermes « OAuth » / « non découvrable » (google, xai, nous…)
 *   ne s'appliquent pas : chez Jarod tout fournisseur du catalogue a un `/models` à clé (même règle que
 *   `discover-provider-models`) ; clé = coffre (jamais l'environnement) ; Anthropic : `<base>/v1/models`.
 *   Analyse de la réponse, cache à vie du processus et marqueur « déjà lu, rien d'annoncé » repris tels quels.
 */
import { AnthropicClient, OpenAICompatibleClient } from "@jarod/plugin-llm";
import { assertProfile, type HandlerContext } from "./context.js";

/** `models.ts:23-56` (champs de définition optionnels omis : Jarod n'a pas `model-definitions.json`). */
export interface SavedModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  createdAt: number;
}

export interface DiscoverModelsResult {
  models: string[];
  status: "ok" | "no-key" | "error" | "unsupported" | "unknown-host";
  cached: boolean;
  freeModels?: string[];
}

const DEFAULT_ANTHROPIC = "https://api.anthropic.com";
const DISCOVERY_TIMEOUT_MS = 10_000;

/** `model-discovery.ts:306-313`. */
interface RawModelMeta {
  id?: string;
  context_length?: number | string;
  context_window?: number | string;
  max_context_length?: number | string;
  max_context_window_tokens?: number | string;
  top_provider?: { context_length?: number | string };
}

/** `model-discovery.ts:315-324`. */
function toPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const n = parseInt(value.trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** `model-discovery.ts:326-338` : les noms de champ des différents fournisseurs (OpenRouter : les deux formes). */
function extractContextLength(item: RawModelMeta): number | null {
  return (
    toPositiveInt(item.context_length) ??
    toPositiveInt(item.context_window) ??
    toPositiveInt(item.max_context_length) ??
    toPositiveInt(item.max_context_window_tokens) ??
    toPositiveInt(item.top_provider?.context_length)
  );
}

/** `model-discovery.ts:340-367` : id → taille annoncée ; vide si illisible ou sans métadonnée. */
export function parseModelContextLengths(body: string): Record<string, number> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return {};
  }
  if (!json || typeof json !== "object") return {};
  const j = json as { data?: RawModelMeta[]; models?: RawModelMeta[] };
  const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : null;
  if (!arr) return {};
  const out: Record<string, number> = {};
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const ctx = extractContextLength(item);
    if (ctx) out[id] = ctx;
  }
  return out;
}

/** `model-discovery.ts:430-437`. */
function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * `GET <base>/models` (`model-discovery.ts:406-429,439-491`) : erreur HTTP = joignable sans données ; réseau ou
 * 10 s dépassées = injoignable (null).
 */
async function fetchContextLengths(url: string, headers: Record<string, string>): Promise<Record<string, number> | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: ac.signal });
    if (!res.ok) {
      await res.body?.cancel();
      return {};
    }
    return parseModelContextLengths(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Plafond de `list-models`. */
export const MAX_LISTED_MODELS = 500;

/** Tronque à `MAX_LISTED_MODELS` en gardant l'entrée `keepId` (le modèle actif, ajouté en dernier donc la première perdue). */
export function boundModels(models: SavedModel[], keepId: string, onTruncated: (total: number) => void): SavedModel[] {
  if (models.length <= MAX_LISTED_MODELS) return models;
  onTruncated(models.length);
  const head = models.slice(0, MAX_LISTED_MODELS);
  if (head.some((m) => m.id === keepId)) return head;
  const kept = models.find((m) => m.id === keepId);
  return kept ? [...head.slice(0, MAX_LISTED_MODELS - 1), kept] : head;
}

export function createModelHandlers(ctx: HandlerContext) {
  const router = () => ctx.kernel().agent.providers;
  const settings = () => ctx.kernel().agent.settings;
  // model-discovery.ts:250-255 : fournisseur|URL → tailles annoncées ; une entrée (même vide) = déjà lu.
  const ctxCache = new Map<string, Record<string, number>>();
  // Borne : `list-models` ne rend pas une quantité illimitée (AV2-009 ; portée de 200 à 500, décision du 2026-10-05). Une liste tronquée
  // est DITE (avertissement journalisé), et le modèle actif reste toujours dans la liste rendue.
  let warnedTotal = 0;

  return {
    "list-models": (): SavedModel[] => {
      const out: SavedModel[] = [];
      const seen = new Set<string>();
      const add = (provider: string, model: string, baseUrl: string) => {
        const id = `${provider}:${model}`;
        if (!model || seen.has(id)) return;
        seen.add(id);
        out.push({ id, name: model, provider, model, baseUrl, createdAt: 0 });
      };
      for (const p of router().list()) if (p.configured) for (const m of p.models) add(p.id, m, p.baseUrl);
      const active = settings().get("activeProvider");
      const def = router()
        .list()
        .find((p) => p.id === active);
      if (def) add(active, settings().get("activeModel"), def.baseUrl);
      return boundModels(out, `${active}:${settings().get("activeModel")}`, (total) => {
        if (total === warnedTotal) return; // une fois par taille, pas à chaque appel de la fenêtre
        warnedTotal = total;
        console.warn(`[models] list-models : ${total} modèles, liste tronquée à ${MAX_LISTED_MODELS} (le modèle actif est conservé)`);
      });
    },
    "discover-provider-models": async (provider: unknown, baseUrl: unknown, apiKey: unknown, profile?: unknown): Promise<DiscoverModelsResult> => {
      assertProfile(ctx, profile);
      const id = typeof provider === "string" ? provider.trim().toLowerCase() : "";
      const def = router()
        .list()
        .find((p) => p.id === id);
      const explicitBase = (typeof baseUrl === "string" ? baseUrl : "").trim().replace(/\/+$/, "");
      const base = explicitBase || def?.baseUrl || "";
      if (!base) return { models: [], status: "unknown-host", cached: false };
      const key = (typeof apiKey === "string" ? apiKey : "").trim() || (def ? (router().apiKeys(def.id)[0] ?? "") : "");
      if (!key && !def?.local) return { models: [], status: "no-key", cached: false };
      try {
        const client =
          def?.protocol === "anthropic" ? new AnthropicClient(key, base === DEFAULT_ANTHROPIC ? undefined : base) : new OpenAICompatibleClient(base, key || undefined);
        // model-discovery.ts:605 : 10 s au plus, puis « injoignable ».
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("délai dépassé")), DISCOVERY_TIMEOUT_MS);
        });
        try {
          return { models: await Promise.race([client.listModels(), timeout]), status: "ok", cached: false };
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return { models: [], status: "error", cached: false };
      }
    },
    // model-discovery.ts:624-690 : null = inconnu, l'écran Chat retombe sur son heuristique (Chat.tsx:416-443).
    "get-model-context-window": async (provider: unknown, model: unknown, baseUrl: unknown, profile?: unknown): Promise<number | null> => {
      assertProfile(ctx, profile);
      const modelId = (typeof model === "string" ? model : "").trim();
      if (!modelId) return null;
      const id = (typeof provider === "string" ? provider : "").trim().toLowerCase();
      const def = router()
        .list()
        .find((p) => p.id === id);
      const explicitBase = (typeof baseUrl === "string" ? baseUrl : "").trim().replace(/\/+$/, "");
      const base = explicitBase || def?.baseUrl.replace(/\/+$/, "") || "";
      if (!base) return null;
      const cacheKey = `${id}|${base.toLowerCase()}`;
      const readCtx = (): number | null => ctxCache.get(cacheKey)?.[modelId] ?? null;
      const cached = readCtx();
      if (cached) return cached;
      if (ctxCache.has(cacheKey)) return null;

      const key = def ? (router().apiKeys(def.id)[0] ?? "") : "";
      if (!key && !(def?.local || (!def && isLoopbackBaseUrl(base)))) return null;
      const anthropic = def?.protocol === "anthropic";
      const url = `${anthropic && !/\/v1$/.test(base) ? `${base}/v1` : base}/models`;
      const headers: Record<string, string> = !key
        ? {}
        : anthropic
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${key}` };
      const lengths = await fetchContextLengths(url, headers);
      if (lengths) ctxCache.set(cacheKey, lengths);
      return readCtx();
    },
  };
}
