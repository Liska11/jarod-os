// Passerelle compatible Hermes : le pont vers les canaux de pilotage de Jarod (`@jarod/bridge` : fournisseurs, modèles locaux, skills, profils, messageries…).
//   POST /api/jarod/invoke   { channel, args? }  →  { result }    (ou { detail } avec un statut d'erreur)
// Les handlers sont ceux de l'application jarod-cordis : leurs règles (validation, refus nommés, garde fichiers) sont celles de l'origine. Seuls changent le
// transport (HTTP au lieu d'IPC Electron) et le « shell » : les boîtes de dialogue sont des demandes à la fenêtre de Jarod-OS (voir `bridge-shell.ts`).
import { redactText } from "@jarod/kernel/redact";

export type BridgeHandlers = Readonly<Record<string, (...args: unknown[]) => unknown>>;

/** Ce que la passerelle sait faire d'un pont : appeler un canal. L'allowlist est celle des contrats (`assertOneaiChannel`), vérifiée AVANT de chercher le handler. */
export interface BridgePort {
  invoke(channel: unknown, args: unknown[]): Promise<unknown>;
}

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Un pont sur une table de handlers ; `assertChannel` lève pour un canal hors allowlist. */
export function createBridgePort(handlers: BridgeHandlers, assertChannel: (channel: unknown) => string): BridgePort {
  return {
    async invoke(channel, args) {
      let name: string;
      try {
        name = assertChannel(channel);
      } catch (e) {
        throw new BridgeError(400, e instanceof Error ? e.message : "canal refusé");
      }
      const fn = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
      if (typeof fn !== "function") throw new BridgeError(404, `canal non porté : ${name}`);
      try {
        return await fn(...args);
      } catch (e) {
        // Un handler refuse en levant une erreur : son message est fait pour être lu (jamais une clé), masqué par prudence.
        throw new BridgeError(400, redactText(e instanceof Error ? e.message : String(e)).slice(0, 2000));
      }
    },
  };
}

/** Le corps d'un appel : `{ channel: string, args?: unknown[] }`. */
export function parseInvokeBody(body: Record<string, unknown>): { channel: string; args: unknown[] } {
  if (typeof body.channel !== "string" || !body.channel) throw new BridgeError(400, "channel attendu");
  if (body.args !== undefined && !Array.isArray(body.args)) throw new BridgeError(400, "args : liste attendue");
  return { channel: body.channel, args: (body.args as unknown[] | undefined) ?? [] };
}
