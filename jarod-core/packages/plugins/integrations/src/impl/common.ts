/**
 * Socle commun des adaptateurs de la phase 5. Principe : un adaptateur écrit le CONTRAT et la politique (ce qui est
 * permis, refusé, journalisé) ; le moteur externe est un `backend` injecté. Sans backend, l'adaptateur est
 * indisponible et ses opérations lèvent `AdapterUnavailable` : jamais un succès silencieux, jamais un repli qui
 * exécuterait quelque chose sans la protection prévue. Aucun adaptateur n'exécute lui-même : ce qui doit tourner est
 * rendu sous forme d'appels (`PlanCall`) destinés à `executeGuardedTool`.
 */
import { createHash } from "node:crypto";

export class AdapterUnavailable extends Error {
  constructor(readonly adapter: string, reason: string) {
    super(`${adapter} indisponible : ${reason}`);
  }
}

export class AdapterRefused extends Error {
  constructor(readonly adapter: string, reason: string) {
    super(`${adapter} refuse : ${reason}`);
  }
}

/** Un appel d'outil à faire passer par la porte unique. */
export interface GuardedCall {
  name: string;
  args: Record<string, unknown>;
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function need<T>(adapter: string, backend: T | undefined | null, what = "moteur non branché"): T {
  if (!backend) throw new AdapterUnavailable(adapter, what);
  return backend;
}
