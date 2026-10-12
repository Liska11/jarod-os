/**
 * Écran Fournisseurs : ce qu'il lit au montage (`Providers.tsx:197-205,258-270,616-620`,
 * `ProviderKeysSection.tsx:584`). Sources SANK-UI : `ipc/register.ts:932-934` (`hermes-account-get` →
 * `account-store.ts:66-73`, null sans compte), `:976-980` (`get-env` → `.env` du profil),
 * `:2398-2400` (`list-custom-providers` → `providers-store.ts:166-173`), `:2636-2638`
 * (`get-credential-pool` → `config.ts:1788-1795`, `{}` sans réserve), `shared/url-key-map.ts`
 * (URL → nom de variable de clé) — rév. 3aaadb0, MIT © github.com/fathah.
 *
 * Écarts assumés (DECISIONS D1(b)) :
 * - `get-env` : les CLÉS NE SORTENT JAMAIS DU MAIN. Hermes rend son `.env` en clair au renderer ; Jarod rend,
 *   pour chaque fournisseur du catalogue dont le coffre a une clé, le nom de variable que SANK-UI associe à son
 *   URL (`expectedEnvKeyForUrl`, table SANK-UI telle quelle) — ou, pour les fournisseurs absents de cette table,
 *   le nom que les écrans SANK-UI lui donnent (`renderer/src/constants.ts:740-910`, `ENV_BY_PROVIDER`) — avec
 *   une valeur MASQUÉE : l'écran voit « clé présente », jamais la clé. Sans nom connu : absent (pas de nom
 *   inventé) ;
 * - pas de compte Hermes One (`hermes-account-get` = null, « déconnecté ») ; pas de fournisseur personnalisé
 *   NOMMÉ (le fournisseur `custom` unique passe par `get/set-model-config`).
 *
 * Écritures (D1(b), suite V1) — sources : `register.ts:1018-1048` (`set-env`, `true`), `:1277-1305`
 * (`invalidate-secrets-cache`, `generate-api-server-key` : `desk-<uuid>`), `:2402-2419` (fournisseurs nommés),
 * `:2640-2667` + `config.ts:1797-1880` (réserve de clés : `setCredentialPool`, `buildCredentialPoolEntry`,
 * `addCredentialPoolEntry` → liste mise à jour), `:2696-2840` (bibliothèque de modèles et définitions) ;
 * usages `Providers.tsx:372-460,616-650`, `ProviderKeysSection.tsx:217-247,670-673`, `Setup.tsx:64-67`,
 * `ConfigHealthBanner.tsx:167`. Écarts assumés :
 * - `set-env` écrit dans le COFFRE du profil (`provider:<id>:apiKey`, `api:openai:key` pour API_SERVER_KEY) ;
 *   valeur égale au masque = « inchangée » (V1) ; valeur contenant le caractère du masque (champ masqué modifié
 *   au lieu d'être vidé) REFUSÉE ; "" = clé retirée ; variable sans équivalent Jarod → ERREUR (jamais `true`
 *   pour une écriture qui n'a pas eu lieu) ;
 * - réserve de clés = les clés SUPPLÉMENTAIRES de Jarod (`provider:<id>:apiKey:<n>`, essayées quand la
 *   principale est refusée — `ProviderRouter.setExtraKeys`) : jeton MASQUÉ, `id` = empreinte (8 hex du SHA-256
 *   de la clé : stable, ne révèle pas la clé), libellé non conservé (« Key N ») ; une entrée masquée dont
 *   l'empreinte n'est pas connue est refusée ; fournisseur Hermes `alibaba` = `qwen` (DashScope) chez Jarod ;
 * - `generate-api-server-key` rend `{ key: <masque> }` (l'écran n'utilise pas la valeur) ;
 * - `invalidate-secrets-cache` : sans objet (le coffre est lu à chaque appel, aucun cache) ;
 * - fournisseurs personnalisés NOMMÉS : absents de Jarod → création refusée, retrait d'un inconnu refusé ;
 * - bibliothèque de modèles = listes `providerOverrides.<id>.models` (la même que `list-models`) ; URL retenue
 *   pour `custom` seulement (règle de `set-model-config`) ; nom affiché et taille de contexte sans équivalent ;
 * - définitions de modèles (`model-definitions.json` d'Hermes) : absentes de Jarod → réponses SANK-UI d'une
 *   connexion sans fichier de définitions (`[]`, `null`, `null`, `false`).
 */
import { createHash, randomUUID } from "node:crypto";
import { API_KEY_SECRET, secretKeyFor } from "@jarod/plugin-llm";
import { CUSTOM_API_KEY_ENV, expectedEnvKeyForUrl } from "../../sank/src/shared/url-key-map.js";
import { assertProfile, type HandlerContext } from "./context.js";
import type { SavedModel } from "./models.js";
import { SECRET_MASK } from "./tools.js";

/**
 * Noms de variables que les écrans SANK-UI donnent aux fournisseurs du catalogue Jarod dont l'URL n'est pas dans
 * `url-key-map.ts` (`renderer/src/constants.ts:740-910`) — même fournisseur, même clé. Moonshot (≠ « Kimi Coding
 * Plan » d'Hermes, autre point d'accès) n'en a pas.
 */
const ENV_BY_PROVIDER: Record<string, string> = {
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  zai: "GLM_API_KEY",
  minimax: "MINIMAX_API_KEY",
  nous: "NOUS_API_KEY",
};
/** Nom Hermes d'un fournisseur → id du catalogue Jarod (réserve de clés, bibliothèque de modèles). */
const PROVIDER_ALIASES: Record<string, string> = { alibaba: "qwen" };
const HERMES_NAME: Record<string, string> = { qwen: "alibaba" };

/** Nom de variable SANK-UI de la clé d'un fournisseur du catalogue ; null = aucun (jamais un nom inventé). */
function envKeyOf(p: { id: string; baseUrl: string }): string | null {
  if (p.id === "custom") return CUSTOM_API_KEY_ENV;
  const named = ENV_BY_PROVIDER[p.id];
  if (named) return named;
  const key = expectedEnvKeyForUrl(p.baseUrl);
  return key === CUSTOM_API_KEY_ENV ? null : key;
}

/** Forme d'une entrée de réserve (`config.ts:1834-1843`, `buildCredentialPoolEntry`), jeton masqué. */
interface PoolEntry {
  id: string;
  label: string;
  auth_type: "api_key";
  priority: number;
  source: "manual";
  access_token: string;
  base_url: string;
  request_count: number;
}

const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8);
const MASK_CHAR = SECRET_MASK[0]!;

export function createProviderHandlers(ctx: HandlerContext) {
  const agent = () => ctx.kernel().agent;
  const settings = () => agent().settings;
  const router = () => agent().providers;
  const catalogId = (provider: unknown): string => {
    const raw = typeof provider === "string" ? provider.trim().toLowerCase() : "";
    const id = PROVIDER_ALIASES[raw] ?? raw;
    if (!router().list().some((p) => p.id === id))
      throw new Error(`Fournisseur « ${String(provider)} » absent du catalogue de Jarod-One`);
    return id;
  };
  /** Clés supplémentaires d'un fournisseur, dans leur ordre (`ProviderRouter.apiKeys` sans la principale). */
  const extraKeys = (id: string): string[] => {
    const prefix = `${secretKeyFor(id)}:`;
    return settings()
      .secretKeys()
      .filter((k) => k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length)))
      .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
      .map((k) => settings().getSecret(k))
      .filter((k): k is string => Boolean(k));
  };
  const poolEntries = (id: string): PoolEntry[] => {
    const baseUrl = router().def(id).baseUrl;
    return extraKeys(id).map((key, i) => ({
      id: fingerprint(key),
      label: `Key ${i + 1}`,
      auth_type: "api_key",
      priority: i,
      source: "manual",
      access_token: SECRET_MASK,
      base_url: baseUrl,
      request_count: 0,
    }));
  };
  const cleanSecret = (value: string): string => {
    const v = value.trim();
    if (v.includes(MASK_CHAR)) throw new Error("Valeur masquée modifiée : videz le champ puis saisissez la clé complète.");
    return v;
  };
  /** Liste de modèles du fournisseur (surcharge, sinon catalogue) → écrite dans `providerOverrides`. */
  const writeModels = (id: string, edit: (models: string[]) => string[]) => {
    const overrides = { ...settings().get("providerOverrides") };
    overrides[id] = { ...overrides[id], models: edit([...router().def(id).models]) };
    settings().set("providerOverrides", overrides);
  };
  const setCustomBaseUrl = (baseUrl: unknown) => {
    const url = typeof baseUrl === "string" ? baseUrl.trim() : "";
    if (!/^https?:\/\//i.test(url)) return;
    const overrides = { ...settings().get("providerOverrides") };
    overrides.custom = { ...overrides.custom, baseUrl: url };
    settings().set("providerOverrides", overrides);
  };
  const parseModelId = (id: unknown): { provider: string; model: string } | null => {
    if (typeof id !== "string") return null;
    const i = id.indexOf(":");
    if (i <= 0 || i === id.length - 1) return null;
    return { provider: id.slice(0, i), model: id.slice(i + 1) };
  };

  return {
    "get-env": (profile?: unknown): Record<string, string> => {
      assertProfile(ctx, profile);
      const env: Record<string, string> = {};
      for (const p of router().list()) {
        if (!p.hasKey) continue;
        const key = envKeyOf(p);
        if (key) env[key] = SECRET_MASK;
      }
      if (settings().secretKeys().includes(API_KEY_SECRET)) env.API_SERVER_KEY = SECRET_MASK;
      return env;
    },
    "set-env": (key: unknown, value: unknown, profile?: unknown): true => {
      assertProfile(ctx, profile);
      if (typeof key !== "string" || !key) throw new Error("Nom de variable attendu");
      const raw = typeof value === "string" ? value : "";
      if (raw === SECRET_MASK) return true;
      const clean = cleanSecret(raw);
      if (key === "API_SERVER_KEY") {
        settings().setSecret(API_KEY_SECRET, clean);
        return true;
      }
      const targets = router()
        .list()
        .filter((p) => envKeyOf(p) === key);
      if (!targets.length) throw new Error(`${key} : sans équivalent dans Jarod-One (non enregistré)`);
      for (const p of targets) settings().setSecret(secretKeyFor(p.id), clean);
      return true;
    },
    "invalidate-secrets-cache": (): void => undefined,
    "generate-api-server-key": (profile?: unknown): { key: string } => {
      assertProfile(ctx, profile);
      settings().setSecret(API_KEY_SECRET, `desk-${randomUUID()}`);
      return { key: SECRET_MASK };
    },
    "hermes-account-get": (profile?: unknown): null => {
      assertProfile(ctx, profile);
      return null;
    },
    "get-credential-pool": (profile?: unknown): Record<string, PoolEntry[]> => {
      assertProfile(ctx, profile);
      const pool: Record<string, PoolEntry[]> = {};
      for (const p of router().list()) {
        const entries = poolEntries(p.id);
        if (entries.length) pool[HERMES_NAME[p.id] ?? p.id] = entries;
      }
      return pool;
    },
    "set-credential-pool": (provider: unknown, entries: unknown, profile?: unknown): true => {
      assertProfile(ctx, profile);
      const id = catalogId(provider);
      if (!Array.isArray(entries)) throw new Error("Liste d'entrées attendue");
      const known = new Map(extraKeys(id).map((k) => [fingerprint(k), k]));
      const next = entries.map((e) => {
        const entry = (e ?? {}) as { id?: unknown; access_token?: unknown };
        const token = typeof entry.access_token === "string" ? entry.access_token : "";
        if (token === SECRET_MASK) {
          const kept = typeof entry.id === "string" ? known.get(entry.id) : undefined;
          if (!kept) throw new Error("Entrée masquée inconnue : ressaisissez la clé.");
          return kept;
        }
        return cleanSecret(token);
      });
      router().setExtraKeys(id, next);
      return true;
    },
    "add-credential-pool-entry": (provider: unknown, apiKey: unknown, _label: unknown, profile?: unknown): PoolEntry[] => {
      assertProfile(ctx, profile);
      const id = catalogId(provider);
      const key = cleanSecret(typeof apiKey === "string" ? apiKey : "");
      if (!key) throw new Error("Clé vide");
      router().setExtraKeys(id, [...extraKeys(id), key]);
      return poolEntries(id);
    },
    "list-custom-providers": (profile?: unknown): never[] => {
      assertProfile(ctx, profile);
      return [];
    },
    "upsert-custom-provider": (profile: unknown): never => {
      assertProfile(ctx, profile);
      throw new Error("Jarod-One n'a pas de fournisseurs personnalisés nommés : un seul fournisseur « custom », réglé par le choix du modèle.");
    },
    "remove-custom-provider": (profile: unknown, name: unknown): never => {
      assertProfile(ctx, profile);
      throw new Error(`Fournisseur personnalisé « ${String(name)} » inconnu`);
    },
    "add-model": (_name: unknown, provider: unknown, model: unknown, baseUrl: unknown): SavedModel => {
      const id = catalogId(provider);
      const m = typeof model === "string" ? model.trim() : "";
      if (!m) throw new Error("Modèle attendu");
      if (id === "custom") setCustomBaseUrl(baseUrl);
      writeModels(id, (models) => (models.includes(m) ? models : [...models, m]));
      return { id: `${id}:${m}`, name: m, provider: id, model: m, baseUrl: router().def(id).baseUrl, createdAt: 0 };
    },
    /** Retiré de la liste du fournisseur ; `false` si le modèle y reste (liste vide = retour au catalogue). */
    "remove-model": (modelId: unknown): boolean => {
      const ref = parseModelId(modelId);
      if (!ref) return false;
      const id = catalogId(ref.provider);
      if (!router().def(id).models.includes(ref.model)) return false;
      writeModels(id, (models) => models.filter((x) => x !== ref.model));
      return !router().def(id).models.includes(ref.model);
    },
    /** `fields.model` (et `fields.provider`) : renommer / déplacer ; nom affiché, URL (hors custom), contexte sans équivalent. */
    "update-model": (modelId: unknown, fields: unknown): boolean => {
      const ref = parseModelId(modelId);
      if (!ref) return false;
      const from = catalogId(ref.provider);
      if (!router().def(from).models.includes(ref.model)) return false;
      const f = (fields && typeof fields === "object" ? fields : {}) as Record<string, unknown>;
      const to = typeof f.provider === "string" && f.provider ? catalogId(f.provider) : from;
      const model = typeof f.model === "string" && f.model.trim() ? f.model.trim() : ref.model;
      if (to === "custom") setCustomBaseUrl(f.baseUrl);
      if (to === from) writeModels(from, (models) => [...new Set(models.map((x) => (x === ref.model ? model : x)))]);
      else {
        writeModels(from, (models) => models.filter((x) => x !== ref.model));
        writeModels(to, (models) => (models.includes(model) ? models : [...models, model]));
      }
      return router().def(to).models.includes(model);
    },
    "list-model-definitions": (): never[] => [],
    "get-model-definition": (): null => null,
    "set-model-definition": (): null => null,
    "remove-model-definition": (): false => false,
  };
}

