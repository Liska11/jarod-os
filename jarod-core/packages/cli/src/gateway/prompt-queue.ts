// File de messages et pilotage en cours de tour (repris de PandaCode), par conversation.
//   - la FILE : des messages écrits pendant qu'un tour tourne ; ils partent l'un après l'autre quand il finit ;
//   - le PILOTAGE : des messages qui entrent dans le tour en cours, lus par l'agent entre deux étapes (`AgentHooks.steering`).
// Logique pure : ni réseau ni noyau, pour que le comportement se teste seul. Le serveur l'appelle et envoie les événements.
import { randomUUID } from "node:crypto";

export interface QueuedPrompt {
  id: string;
  text: string;
  /** Instant d'ajout (ms), pour l'affichage. */
  at: number;
}

export const MAX_QUEUED = 20;
export const MAX_STEERING = 10;
/** Un message mis en file ou de pilotage tient dans un prompt ordinaire : même borne que la zone de saisie. */
export const MAX_PROMPT_CHARS = 200_000;

export class PromptQueueError extends Error {}

function checked(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new PromptQueueError("message vide");
  if (trimmed.length > MAX_PROMPT_CHARS) throw new PromptQueueError(`message trop long (plus de ${MAX_PROMPT_CHARS} caractères)`);
  return trimmed;
}

export class PromptQueue {
  private readonly queues = new Map<string, QueuedPrompt[]>();
  private readonly steers = new Map<string, string[]>();

  /** Met un message en file ; il part quand le tour en cours se termine. */
  add(sessionId: string, text: string, now: number = Date.now()): QueuedPrompt {
    const list = this.queues.get(sessionId) ?? [];
    if (list.length >= MAX_QUEUED) throw new PromptQueueError(`la file est pleine (${MAX_QUEUED} messages)`);
    const item = { id: randomUUID(), text: checked(text), at: now };
    this.queues.set(sessionId, [...list, item]);
    return item;
  }

  list(sessionId: string): QueuedPrompt[] {
    return [...(this.queues.get(sessionId) ?? [])];
  }

  remove(sessionId: string, id: string): boolean {
    const list = this.queues.get(sessionId) ?? [];
    const kept = list.filter((item) => item.id !== id);
    if (kept.length === list.length) return false;
    this.store(sessionId, kept);
    return true;
  }

  clear(sessionId: string): number {
    const count = this.queues.get(sessionId)?.length ?? 0;
    this.queues.delete(sessionId);
    return count;
  }

  /** Le prochain message à envoyer, retiré de la file. */
  next(sessionId: string): QueuedPrompt | undefined {
    const [first, ...rest] = this.queues.get(sessionId) ?? [];
    if (!first) return undefined;
    this.store(sessionId, rest);
    return first;
  }

  /** Remet en tête un message qu'on venait de retirer (son départ a échoué) : il garde son identifiant et sa place. */
  pushFront(sessionId: string, item: QueuedPrompt): void {
    this.store(sessionId, [item, ...(this.queues.get(sessionId) ?? [])]);
  }

  /** Ajoute un message de pilotage au tour en cours ; rend le nombre de messages qui attendent d'être lus. */
  steer(sessionId: string, text: string): number {
    const list = this.steers.get(sessionId) ?? [];
    if (list.length >= MAX_STEERING) throw new PromptQueueError(`trop de messages de pilotage en attente (${MAX_STEERING})`);
    const next = [...list, checked(text)];
    this.steers.set(sessionId, next);
    return next.length;
  }

  /** La boîte que lit la boucle de l'agent : `peek` sans retirer, `take` en vidant. */
  steering(sessionId: string): { peek(): boolean; take(): string[] } {
    return {
      peek: () => (this.steers.get(sessionId)?.length ?? 0) > 0,
      take: () => {
        const taken = this.steers.get(sessionId) ?? [];
        this.steers.delete(sessionId);
        return taken;
      },
    };
  }

  /**
   * Le tour s'est terminé avant que l'agent lise ces messages de pilotage : ils passent EN TÊTE de la file, dans l'ordre où ils ont été écrits,
   * pour ne pas être perdus. Rend leur nombre.
   */
  demoteSteering(sessionId: string, now: number = Date.now()): number {
    const pending = this.steers.get(sessionId) ?? [];
    this.steers.delete(sessionId);
    if (!pending.length) return 0;
    const items = pending.map((text) => ({ id: randomUUID(), text, at: now }));
    this.store(sessionId, [...items, ...(this.queues.get(sessionId) ?? [])]);
    return items.length;
  }

  forget(sessionId: string): void {
    this.queues.delete(sessionId);
    this.steers.delete(sessionId);
  }

  private store(sessionId: string, list: QueuedPrompt[]): void {
    if (list.length) this.queues.set(sessionId, list);
    else this.queues.delete(sessionId);
  }
}
