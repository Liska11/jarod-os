/**
 * @jarod/plugin-quarantine — `ctx.quarantine` : empreintes, provenance, analyse, promotion contrôlée, et (V-07) admission des entrées
 * externes. Voir `quarantine.ts` pour les règles tenues. Aucun canal d'approbation n'est branché par défaut : sans lui, rien ne sort par
 * `promote`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "cordis";
import { type Approver, QuarantineService, type Scanner } from "./quarantine.js";

export * from "./quarantine.js";

declare module "cordis" {
  interface Context {
    quarantine: QuarantineService;
  }
}

export const name = "quarantine";
// Le dossier de données du profil, s'il est là (plugin-storage, ordre inférieur) : la quarantaine vit avec le profil, pas dans %TEMP%.
export const inject = { storage: { required: false } };

export interface QuarantineConfig {
  root?: string;
  approve?: Approver | null;
  /** L'analyseur ; par défaut Microsoft Defender (`MpCmdRun.exe`). Les tests en fournissent un déterministe. */
  scanner?: Scanner;
}

export function apply(ctx: Context, config: QuarantineConfig = {}): void {
  const storage = ctx.get("storage") as unknown as { dataDir?: string } | undefined;
  const root = config.root ?? (storage?.dataDir ? join(storage.dataDir, "quarantine") : join(tmpdir(), "jarod-quarantine"));
  ctx.provide("quarantine", new QuarantineService({ root, approve: config.approve ?? null, ...(config.scanner ? { scanner: config.scanner } : {}) }));
}
