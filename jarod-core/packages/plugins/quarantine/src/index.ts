/**
 * @jarod/plugin-quarantine — `ctx.quarantine` : empreintes, provenance, analyse, promotion contrôlée.
 * Voir `quarantine.ts` pour les règles tenues. Aucun canal d'approbation n'est branché par défaut : sans lui,
 * rien ne sort.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "cordis";
import { type Approver, QuarantineService } from "./quarantine.js";

export * from "./quarantine.js";

declare module "cordis" {
  interface Context {
    quarantine: QuarantineService;
  }
}

export const name = "quarantine";

export interface QuarantineConfig {
  root?: string;
  approve?: Approver | null;
}

export function apply(ctx: Context, config: QuarantineConfig = {}): void {
  ctx.provide("quarantine", new QuarantineService({ root: config.root ?? join(tmpdir(), "jarod-quarantine"), approve: config.approve ?? null }));
}
