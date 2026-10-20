/**
 * Écran « Contexte » (cockpit, lots 3 et 4) : ce qui garde le contexte maîtrisé, mesuré.
 *  - les sorties volumineuses gardées hors du contexte (nombre, caractères économisés) ;
 *  - le proxy de compression de l'historique (billion-context) : réglage, et sa santé lue sur `/__bili/health` (bouclage seulement) ;
 *  - l'autorité de compression de chaque fournisseur : Jarod (compaction) ou billion-context — jamais les deux.
 * Lecture seule ; les réglages passent par `set-jarod-settings` (validation, confirmation).
 */
import { isLoopbackUrl } from "@jarod/plugin-llm";
import type { HandlerContext } from "./context.js";

export interface ContextStatus {
  outputs: { outputs: number; storedChars: number; previewChars: number; savedChars: number; threshold: number };
  compactThreshold: number;
  proxy: { enabled: boolean; url: string; providers: string[]; health: "ok" | "unreachable" | "off"; upstream?: string; detail?: string };
}

/** Lit la santé du proxy ; jamais ailleurs que sur une adresse de bouclage, délai court, rien d'envoyé. */
export async function proxyHealth(url: string, fetchImpl: typeof fetch = fetch): Promise<{ health: "ok" | "unreachable"; upstream?: string; detail?: string }> {
  if (!isLoopbackUrl(url)) return { health: "unreachable", detail: "adresse hors bouclage refusée" };
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/__bili/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { health: "unreachable", detail: `HTTP ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; upstream?: unknown };
    return body.ok === true ? { health: "ok", ...(typeof body.upstream === "string" ? { upstream: body.upstream } : {}) } : { health: "unreachable", detail: "réponse inattendue" };
  } catch (e) {
    return { health: "unreachable", detail: (e as Error).message };
  }
}

export function createContextHandlers(ctx: HandlerContext, o: { fetch?: typeof fetch } = {}) {
  return {
    "context-status": async (): Promise<ContextStatus> => {
      const agent = ctx.kernel().agent;
      const s = agent.settings.getAll();
      const cfg = s.contextProxy;
      const h = cfg.enabled ? await proxyHealth(cfg.url, o.fetch) : { health: "off" as const };
      return {
        outputs: { ...agent.outputs.stats(), threshold: agent.outputs.threshold },
        compactThreshold: s.compactThreshold,
        proxy: { enabled: cfg.enabled, url: cfg.url, providers: [...cfg.providers], ...h },
      };
    },
  };
}
