// Passerelle compatible Hermes : l'écran « Providers » du shell — fournisseurs de modèles, clés API, adresses et listes de modèles.
// Équivalent de l'écran Fournisseurs de l'application Jarod (`handlers/providers.ts`), sans passer par un IPC Electron.
//
// Règle de fond : une clé ENTRE par ici et ne ressort JAMAIS (ni dans une réponse, ni dans un message d'erreur, ni dans le journal). L'écran
// voit « clé présente » et le nombre de clés supplémentaires ; pour changer une clé, il en envoie une autre.
import { redactText } from "@jarod/kernel/redact";
import { ConfigError } from "./config.js";

/** Un fournisseur tel que le routeur du noyau le décrit (`ProviderRouter.list()`). */
export interface ProviderInfoLike {
  id: string;
  name: string;
  protocol?: string;
  baseUrl: string;
  local?: boolean;
  models: readonly string[];
  keyUrl?: string;
  hasKey?: boolean;
  configured: boolean;
  extraKeys?: number;
}

/** Les réglages et le coffre : ce que cet écran écrit. */
export interface ProviderSettingsPort {
  get(key: string): unknown;
  patch(values: Record<string, unknown>): void;
  setSecret(key: string, value: string): void;
}

export interface ProviderRouterPort {
  list(): readonly ProviderInfoLike[];
  setExtraKeys(id: string, keys: string[]): void;
  client(id: string): { listModels(): Promise<string[]> };
}

/** Le nom, dans le coffre, de la clé principale d'un fournisseur (même nom que `secretKeyFor` du plugin llm). */
export const keySecretName = (providerId: string): string => `provider:${providerId}:apiKey`;

const MAX_KEY_CHARS = 2048;
const MAX_MODELS = 500;
const MAX_MODEL_CHARS = 200;

/** D'où viennent les clés : noms du coffre, et variable d'environnement par nom de clé (voir `keySources` de context.ts). */
export interface KeySources {
  vault: readonly string[];
  env: Readonly<Record<string, string>>;
}

export function providerRows(list: readonly ProviderInfoLike[], activeProvider: string, activeModel: string, sources?: KeySources): { providers: Record<string, unknown>[]; active: { provider: string; model: string } } {
  const vault = new Set(sources?.vault ?? []);
  return {
    providers: list.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol ?? "openai",
      base_url: p.baseUrl,
      local: Boolean(p.local),
      models: [...p.models],
      key_url: p.keyUrl ?? null,
      has_key: p.hasKey ?? false,
      // « env » : la clé vient d'une variable d'environnement (rien à retirer ici) ; le coffre, s'il en a une aussi, passe devant.
      key_source: !p.hasKey ? null : sources && !vault.has(keySecretName(p.id)) && sources.env[keySecretName(p.id)] ? "env" : "vault",
      env_var: sources && !vault.has(keySecretName(p.id)) ? (sources.env[keySecretName(p.id)] ?? null) : null,
      extra_keys: p.extraKeys ?? 0,
      configured: p.configured,
      active: p.id === activeProvider,
    })),
    active: { provider: activeProvider, model: activeModel },
  };
}

function known(list: readonly ProviderInfoLike[], id: string): ProviderInfoLike {
  const p = list.find((x) => x.id === id);
  if (!p) throw new ConfigError(`Fournisseur inconnu : ${id}`);
  return p;
}

/** Une clé collée avec une espace, un retour à la ligne ou un guillemet est presque toujours une erreur de copie : on la refuse plutôt que de la stocker. */
export function cleanKey(value: unknown): string {
  if (typeof value !== "string") throw new ConfigError("La clé doit être un texte.");
  const key = value.trim();
  if (!key) throw new ConfigError("La clé est vide : utilisez « Retirer » pour l'effacer.");
  if (key.length > MAX_KEY_CHARS) throw new ConfigError(`Clé trop longue (plus de ${MAX_KEY_CHARS} caractères).`);
  if (/[\s"'`]/.test(key) || /[^\x21-\x7e]/.test(key)) throw new ConfigError("La clé contient une espace, un guillemet ou un caractère non imprimable : copiez-la de nouveau, sans rien autour.");
  return key;
}

export function setProviderKey(settings: ProviderSettingsPort, list: readonly ProviderInfoLike[], id: string, value: unknown): void {
  const p = known(list, id);
  settings.setSecret(keySecretName(p.id), cleanKey(value));
}

export function clearProviderKey(settings: ProviderSettingsPort, list: readonly ProviderInfoLike[], id: string): void {
  settings.setSecret(keySecretName(known(list, id).id), "");
}

/** Les clés supplémentaires essayées quand la principale est refusée : remplacées en bloc, dans l'ordre reçu. */
export function setExtraProviderKeys(router: ProviderRouterPort, id: string, value: unknown): void {
  const p = known(router.list(), id);
  if (!Array.isArray(value)) throw new ConfigError("Une liste de clés est attendue.");
  if (value.length > 20) throw new ConfigError("Au plus 20 clés supplémentaires.");
  router.setExtraKeys(p.id, value.map(cleanKey));
}

function cleanBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new ConfigError("L'adresse doit être un texte.");
  const text = value.trim();
  if (!text) return "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError("Adresse invalide : http://hôte:port/chemin attendu.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("L'adresse doit commencer par http:// ou https://.");
  // Une clé n'a pas à se loger dans l'adresse (elle serait lisible dans les réglages) : elle va dans le coffre.
  if (url.username || url.password) throw new ConfigError("L'adresse ne doit pas contenir d'identifiants : saisissez la clé à part.");
  return text.replace(/\/+$/, "");
}

function cleanModels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ConfigError("Une liste de modèles est attendue.");
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new ConfigError("Chaque modèle doit être un texte.");
    const m = item.trim();
    if (!m) continue;
    if (m.length > MAX_MODEL_CHARS) throw new ConfigError(`Nom de modèle trop long (plus de ${MAX_MODEL_CHARS} caractères).`);
    seen.add(m);
  }
  if (seen.size > MAX_MODELS) throw new ConfigError(`Au plus ${MAX_MODELS} modèles.`);
  return [...seen];
}

/**
 * Adresse et/ou liste de modèles d'un fournisseur (`providerOverrides.<id>`). Une valeur vide efface la surcharge, donc revient au catalogue.
 * Les autres champs de la surcharge sont conservés tels quels.
 */
export function setProviderOverride(settings: ProviderSettingsPort, list: readonly ProviderInfoLike[], id: string, body: Record<string, unknown>): void {
  const p = known(list, id);
  const all = (settings.get("providerOverrides") ?? {}) as Record<string, Record<string, unknown>>;
  const next: Record<string, unknown> = { ...all[p.id] };
  if ("baseUrl" in body) {
    const url = cleanBaseUrl(body.baseUrl);
    if (url) next.baseUrl = url;
    else delete next.baseUrl;
  }
  if ("models" in body) {
    const models = cleanModels(body.models);
    if (models.length) next.models = models;
    else delete next.models;
  }
  const merged = { ...all };
  if (Object.keys(next).length) merged[p.id] = next;
  else delete merged[p.id];
  settings.patch({ providerOverrides: merged });
}

export interface ProviderTestResult {
  ok: boolean;
  models: number;
  error?: string;
}

/** « Tester » : demande la liste des modèles avec la clé enregistrée. L'erreur est dite sans clé (masquée) et sans dépasser 300 caractères. */
export async function testProvider(router: ProviderRouterPort, id: string, timeoutMs = 15_000): Promise<ProviderTestResult> {
  const p = known(router.list(), id);
  if (!p.configured) return { ok: false, models: 0, error: p.local ? "Serveur non configuré." : "Aucune clé enregistrée pour ce fournisseur." };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Pas de réponse en ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs)));
    const models = await Promise.race([router.client(p.id).listModels(), timeout]);
    return { ok: true, models: models.length };
  } catch (e) {
    return { ok: false, models: 0, error: redactText(e instanceof Error ? e.message : String(e)).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
