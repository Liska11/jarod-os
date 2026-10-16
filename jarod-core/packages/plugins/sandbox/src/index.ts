/**
 * @jarod/plugin-sandbox — `ctx.sandbox` : bacs à sable jetables (profil, création, exécution confinée,
 * collecte, destruction). Aucune commande ne part sans passer par le garde du shell : voir `sandbox.ts`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "cordis";
import { SandboxService } from "./sandbox.js";

export * from "./sandbox.js";

declare module "cordis" {
  interface Context {
    sandbox: SandboxService;
  }
}

export const name = "sandbox";

export interface SandboxConfig {
  root?: string;
}

export function apply(ctx: Context, config: SandboxConfig = {}): void {
  ctx.provide("sandbox", new SandboxService({ root: config.root ?? join(tmpdir(), "jarod-sandboxes") }));
}
