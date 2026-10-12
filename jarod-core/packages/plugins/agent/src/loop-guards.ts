// Portage de packages/core/src/services/loop-guards.ts (rév. 2e180305).
/**
 * Two guards the agent loop lacks, and their absence is silent — which is the problem.
 *
 * The first: a model that calls the same tool with the same arguments again and again burns tokens
 * and time without ever saying so. Nothing is broken, so nothing is reported; the loop simply never
 * ends. The guard counts identical calls and hands the loop a reminder to change approach or
 * conclude.
 *
 * The second: a tool that never returns stalls the whole turn. A per-call deadline turns that into
 * an error the model can read and act on.
 */

/** Le délai par défaut d'un appel d'outil, et le nombre d'appels identiques tolérés. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const DEFAULT_REPEAT_THRESHOLD = 3;

export interface RepeatVerdict {
  /** Combien de fois cette appel, identique, a été vu — celui-ci compris. */
  count: number;
  /** Un message à remettre au modèle, ou null tant que le seuil n'est pas atteint. */
  reminder: string | null;
}

export class LoopGuardService {
  private readonly calls = new Map<string, number>();
  private last = "";

  constructor(private readonly d: { repeatThreshold?: number; callTimeoutMs?: number } = {}) {}

  /**
   * Enregistre un appel et dit si le modèle tourne en rond.
   *
   * La clé est le nom plus les arguments **sérialisés de façon stable** : `{a:1,b:2}` et `{b:2,a:1}`
   * sont le même appel pour un modèle, et un garde-fou qui ne le verrait pas ne verrait rien.
   */
  observe(name: string, args: unknown): RepeatVerdict {
    const key = `${name}:${stable(args)}`;
    // Seules les répétitions CONSÉCUTIVES comptent : le même appel séparé par du travail utile n'est
    // pas une boucle, et un garde-fou qui confond les deux crie au loup sur un agent qui travaille.
    if (key !== this.last) this.calls.clear();
    this.last = key;
    const count = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, count);
    const threshold = this.d.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
    if (count < threshold) return { count, reminder: null };
    return {
      count,
      reminder:
        `Tu as appelé ${name} ${count} fois de suite avec exactement les mêmes arguments, et rien n'a changé. ` +
        "Change d'approche, ou conclus en disant ce qui bloque.",
    };
  }

  /** Un nouveau tour efface la mémoire du précédent : un appel répété hier n'est pas une boucle. */
  reset(): void {
    this.calls.clear();
    this.last = "";
  }

  /** Ce qui a été vu, pour le diagnostic : le nom et le nombre d'occurrences. Pour rien d'autre. */
  seen(): { key: string; count: number }[] {
    return [...this.calls.entries()].map(([key, count]) => ({ key, count }));
  }

  /**
   * Exécute un appel d'outil sous délai. Au-delà, une erreur explicite qui nomme l'outil et la durée
   * — pas une promesse qui ne finit jamais et un tour qui ne finit pas non plus.
   */
  async guard<T>(name: string, run: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T> {
    const limit = timeoutMs ?? this.d.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const controller = new AbortController();
    const expired = new Error(`TOOL_TIMEOUT: ${name} n'a pas répondu en ${limit} ms`);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(expired);
      }, limit);
    });
    try {
      return await Promise.race([run(controller.signal), deadline]);
    } catch (error) {
      // L'outil interrompu rejette souvent sa propre erreur avant que le délai ne la sienne : c'est
      // le délai qui doit s'afficher, parce que c'est lui la cause. Sans ça, le diagnostic est perdu.
      if (timedOut) throw expired;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Une sérialisation stable : les clés d'un objet sont triées, à toute profondeur. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${key}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}
