// Passerelle compatible Hermes (essai) : les modèles que les serveurs LOCAUX (LM Studio, Ollama, llama.cpp, vLLM…) proposent à cet instant.
// Le catalogue de Jarod livre ces fournisseurs avec `models: []` : sans découverte, le sélecteur de Herald (qui ne montre que les fournisseurs ayant au
// moins un modèle) restait vide. La découverte est `GET <base>/models` du fournisseur (même client que l'application Jarod, clé du coffre comprise).
// Par défaut, jamais de requête vers un fournisseur distant : seuls les fournisseurs `local` sont interrogés, donc aucune clé ne part vers un tiers.
// Avec `remote`, un fournisseur distant est lu AUSSI, mais seulement s'il est configuré (l'utilisateur a mis sa clé) et n'a aucun modèle déclaré :
// sans cela le sélecteur le cachait. La clé ne va qu'à ce fournisseur, comme au bouton « Tester » de l'écran des fournisseurs.
import type { ProviderLike } from "./config.js";

export interface DiscoveryOptions {
  list: () => readonly ProviderLike[];
  /** `GET <base>/models` du fournisseur ; absent (faux noyau) : pas de découverte. */
  fetchModels?: (providerId: string) => Promise<string[]>;
  /** Durée de validité d'une liste lue : un modèle chargé après l'ouverture de Herald apparaît à la lecture suivante, sans redémarrage. */
  ttlMs?: number;
  /** Durée de validité d'un échec (serveur éteint) : plus courte, pour qu'un serveur lancé après coup soit vu vite sans le marteler. */
  failureTtlMs?: number;
  /** Au-delà, le serveur est tenu pour injoignable (la liste reste celle du catalogue). */
  timeoutMs?: number;
  /** Lire aussi les fournisseurs distants configurés qui n'ont aucun modèle déclaré (voir l'en-tête). Défaut : non. */
  remote?: boolean;
  /** Validité d'une liste distante (longue : un appel réseau et une clé, pas un serveur local) et d'un échec distant. */
  remoteTtlMs?: number;
  remoteFailureTtlMs?: number;
  /** Délai d'une lecture distante (plus long qu'en local). */
  remoteTimeoutMs?: number;
  now?: () => number;
}

interface Entry {
  at: number;
  ttl: number;
  models: string[] | null;
}

/** Les fournisseurs locaux qui ne parlent pas : jamais proposés comme modèle de conversation (le Whisper local ne fait que transcrire). */
export const NON_CHAT_PROVIDERS: ReadonlySet<string> = new Set(["local-whisper-cpp", "local-whisper-cpu"]);

/** Les modèles d'embedding que LM Studio et d'autres listent avec les modèles de conversation : inutilisables pour converser. */
export const isEmbeddingModel = (id: string): boolean => /embed/i.test(id);

export class ModelDiscovery {
  private readonly cache = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<string[] | null>>();
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly o: DiscoveryOptions) {
    this.ttlMs = o.ttlMs ?? 5_000;
    this.failureTtlMs = o.failureTtlMs ?? 2_000;
    this.timeoutMs = o.timeoutMs ?? 2_000;
    this.now = o.now ?? Date.now;
  }

  /** Oublie ce qui a été lu (d'un fournisseur, ou de tous) : à appeler quand l'utilisateur change de fournisseur ou de modèle. */
  invalidate(providerId?: string): void {
    if (!providerId) return this.cache.clear();
    for (const key of this.cache.keys()) if (key.startsWith(`${providerId}\n`)) this.cache.delete(key);
  }

  /** Les fournisseurs du noyau, chaque fournisseur local joignable avec ses modèles du moment ajoutés à ceux que le catalogue ou l'utilisateur déclare. */
  async providers(): Promise<ProviderLike[]> {
    const all = this.o.list();
    const found = await Promise.all(all.map((p) => (this.o.fetchModels && this.readable(p) ? this.read(p) : null)));
    return all.map((p, i) => {
      const live = found[i];
      if (!live) return p;
      return { ...p, models: [...new Set([...live, ...p.models])] };
    });
  }

  /** Un fournisseur local qui converse ; avec `remote`, aussi un fournisseur distant configuré dont aucun modèle n'est déclaré. */
  private readable(p: ProviderLike): boolean {
    if (NON_CHAT_PROVIDERS.has(p.id)) return false;
    if (p.local) return true;
    return this.o.remote === true && p.configured && p.models.length === 0;
  }

  // Clé = fournisseur + adresse : changer l'adresse d'un fournisseur (réglage) invalide sa lecture sans autre geste.
  private read(p: ProviderLike): Promise<string[] | null> {
    const key = `${p.id}\n${p.baseUrl}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < hit.ttl) return Promise.resolve(hit.models);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const remote = !p.local;
    const run = this.fetch(p.id, remote ? (this.o.remoteTimeoutMs ?? 6_000) : this.timeoutMs).then((models) => {
      const ttl = remote ? (models ? (this.o.remoteTtlMs ?? 600_000) : (this.o.remoteFailureTtlMs ?? 30_000)) : models ? this.ttlMs : this.failureTtlMs;
      this.cache.set(key, { at: this.now(), ttl, models });
      this.inFlight.delete(key);
      return models;
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async fetch(providerId: string, timeoutMs: number): Promise<string[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("délai dépassé")), timeoutMs);
      });
      const ids = await Promise.race([this.o.fetchModels!(providerId), timeout]);
      return ids.filter((id) => typeof id === "string" && id && !isEmbeddingModel(id));
    } catch {
      return null; // injoignable, refusé ou illisible : le fournisseur garde la liste du catalogue
    } finally {
      clearTimeout(timer);
    }
  }
}
