// Portage de packages/core/src/providers/index.ts (rév. 2e180305).
import type { SettingsService } from "@jarod/plugin-storage";
import { AnthropicClient } from "./anthropic.js";
import { PROVIDERS } from "./catalog.js";
import { OpenAICompatibleClient } from "./openai.js";
import { type ProviderClient, type ProviderDef, ProviderError } from "@jarod/contracts";

export { estimateCost, PROVIDERS } from "./catalog.js";
export * from "@jarod/contracts";

export interface ProviderInfo extends ProviderDef {
  hasKey: boolean;
  configured: boolean;
  /** Number of extra keys (the main one excluded). */
  extraKeys: number;
}

export const secretKeyFor = (providerId: string): string => `provider:${providerId}:apiKey`;
/** Extra keys of a provider (`provider:<id>:apiKey:2`, `:3`…), tried when the main one is refused. */
export const extraKeyFor = (providerId: string, n: number): string => `${secretKeyFor(providerId)}:${n}`;

/** Resolves provider definitions + user overrides + stored keys into ready-to-use clients. */
/** The step run before a chat call (local models: load what it names). It may return a release, called once the call is over. */
export type Preparer = (model: string, signal?: AbortSignal) => Promise<(() => void) | void>;

export class ProviderRouter {
  /** The key that answered last, per provider: the next turn starts with it. */
  private preferred = new Map<string, number>();
  /** Ce qu'il faut faire AVANT un appel à ce fournisseur (hotswap des modèles locaux : charger le modèle demandé). */
  private readonly preparers = new Map<string, Preparer>();

  constructor(private readonly settings: SettingsService) {}

  /** Every key of a provider, the main one first, then the extra ones in their order. */
  apiKeys(id: string): string[] {
    const prefix = `${secretKeyFor(id)}:`;
    const extras = this.settings
      .secretKeys()
      .filter((k) => k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length)))
      .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
    return [secretKeyFor(id), ...extras].map((k) => this.settings.getSecret(k)).filter((k): k is string => Boolean(k));
  }

  /** Replaces the extra keys of a provider (empty lines are dropped). */
  setExtraKeys(id: string, keys: string[]): void {
    const prefix = `${secretKeyFor(id)}:`;
    for (const k of this.settings.secretKeys()) if (k.startsWith(prefix)) this.settings.setSecret(k, "");
    const kept = keys.map((k) => k.trim()).filter(Boolean);
    for (const [i, k] of kept.entries()) this.settings.setSecret(extraKeyFor(id, i + 2), k);
    this.preferred.delete(id);
  }

  /** The order in which to try the keys: the one that answered last first, then the others. */
  keyOrder(id: string): number[] {
    const n = Math.max(1, this.apiKeys(id).length);
    const start = (this.preferred.get(id) ?? 0) % n;
    return Array.from({ length: n }, (_, i) => (start + i) % n);
  }

  /** Remembers the key that answered, so the next turn does not start with a refused one. */
  keyWorked(id: string, index: number): void {
    this.preferred.set(id, index);
  }

  def(id: string): ProviderDef {
    const base = PROVIDERS.find((p) => p.id === id);
    if (!base) throw new ProviderError(`Fournisseur inconnu : ${id}`);
    const override = this.settings.get("providerOverrides")[id] ?? {};
    const baseUrl = override.baseUrl || base.baseUrl;
    return {
      ...base,
      baseUrl,
      models: override.models?.length ? override.models : base.models,
    };
  }

  list(): ProviderInfo[] {
    const keys = new Set(this.settings.secretKeys());
    return PROVIDERS.map((p) => {
      const def = this.def(p.id);
      const hasKey = keys.has(secretKeyFor(p.id));
      const extraKeys = [...keys].filter((k) => k.startsWith(`${secretKeyFor(p.id)}:`)).length;
      return { ...def, hasKey, configured: hasKey || Boolean(def.local), extraKeys };
    });
  }

  /**
   * Registers (or removes, with null) the step run before every chat call to a provider. Used by the local models' hotswap: the model the call
   * names is loaded first. The provider's address is read again AFTER that step (loading may (re)start the server that serves it).
   */
  setPreparer(id: string, prepare: Preparer | null): void {
    if (prepare) this.preparers.set(id, prepare);
    else this.preparers.delete(id);
  }

  /** A client for the provider, with its `keyIndex`-th key (the main one by default). */
  client(id: string, keyIndex = 0): ProviderClient {
    const direct = this.directClient(id, keyIndex);
    if (!this.preparers.has(id)) return direct;
    return {
      chat: async (req, handlers) => {
        // The step may hand back a lease: held for the WHOLE call (the stream included), released however it ends. The local models use
        // it to know which model a response is still running on — a swap waits for it instead of stopping the server under it.
        const release = await this.preparers.get(id)?.(req.model, req.signal);
        try {
          return await this.directClient(id, keyIndex).chat(req, handlers);
        } finally {
          if (typeof release === "function") release();
        }
      },
      listModels: () => direct.listModels(),
    };
  }

  private directClient(id: string, keyIndex: number): ProviderClient {
    const resolved = this.def(id);
    // Cockpit, lot 4 : le transport seul passe par le proxy de compression ; `def()` (affiché, enregistré) garde l'adresse du fournisseur.
    const def = { ...resolved, baseUrl: viaContextProxy(this.settings.get("contextProxy"), id, resolved.baseUrl, Boolean(resolved.local)) };
    const keys = this.apiKeys(id);
    const key = keys[keyIndex] ?? keys[0];
    if (!key && !def.local) {
      throw new ProviderError(`Aucune clé API pour ${def.name}. Ajoutez-la dans Paramètres → Fournisseurs.`);
    }
    if (def.protocol === "anthropic") {
      return new AnthropicClient(key, def.baseUrl === "https://api.anthropic.com" ? undefined : def.baseUrl);
    }
    const extra: Record<string, string> =
      id === "openrouter" ? { "HTTP-Referer": "https://github.com/jarod-one", "X-Title": "Jarod-One" } : {};
    return new OpenAICompatibleClient(def.baseUrl, key, extra);
  }

  async refreshModels(id: string): Promise<string[]> {
    const models = await this.client(id).listModels();
    const overrides = { ...this.settings.get("providerOverrides") };
    overrides[id] = { ...overrides[id], models };
    this.settings.set("providerOverrides", overrides);
    return models;
  }
}

/** Cockpit, lot 4 : seule une adresse de bouclage peut servir de proxy de compression (rien ne part ailleurs par ce réglage). */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * Cockpit, lot 4 — billion-context, « option 3 » de son mode d'emploi : l'adresse du fournisseur, préfixée par `<proxy>/bili/`. Le proxy
 * transmet au fournisseur d'origine (porté dans le chemin). Seulement si le réglage est allumé, le fournisseur nommé, l'adresse de
 * bouclage, et jamais pour un fournisseur LOCAL (rien à compresser hors de la machine… et rien à faire transiter).
 */
export function viaContextProxy(cfg: { enabled: boolean; url: string; providers: string[] } | undefined, id: string, baseUrl: string, local: boolean): string {
  if (!cfg?.enabled || local || !cfg.providers.includes(id) || !isLoopbackUrl(cfg.url) || !/^https:\/\//.test(baseUrl)) return baseUrl;
  return `${cfg.url.replace(/\/+$/, "")}/bili/${baseUrl}`;
}
