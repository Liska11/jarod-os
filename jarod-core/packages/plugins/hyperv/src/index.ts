/**
 * @jarod/plugin-hyperv — `ctx.hyperv` : modèles VHDX, différentiels, machines, points de contrôle, réseau
 * virtuel isolé, retour arrière. Voir `hyperv.ts` pour ce qui est garanti et pour ce qui n'est pas prouvé.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "cordis";
import { HyperVService } from "./hyperv.js";

export * from "./hyperv.js";

declare module "cordis" {
  interface Context {
    hyperv: HyperVService;
  }
}

export const name = "hyperv";

export interface HyperVConfig {
  root?: string;
}

export function apply(ctx: Context, config: HyperVConfig = {}): void {
  ctx.provide("hyperv", new HyperVService({ root: config.root ?? join(tmpdir(), "jarod-hyperv") }));
}
