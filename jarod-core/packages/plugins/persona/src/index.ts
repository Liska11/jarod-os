/**
 * @jarod/plugin-persona — `ctx.persona` : SOUL.md du profil (`persona.ts`), et les profils
 * (`profiles.ts`, lib utilisée par le CLI). Câblage `core.ts:381` : le fichier vit dans le dossier
 * du profil (`dataDir`). Q4 = A : s'il existe, SOUL.md EST la persona (plugin-agent), le réglage
 * `persona` sert de repli.
 */
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { PersonaService } from "./persona.js";

export * from "./persona.js";
export * from "./profiles.js";

declare module "cordis" {
  interface Context {
    persona: PersonaService;
  }
}

export const name = "persona";
export const inject = ["storage"];

export function apply(ctx: Context): void {
  const dataDir = ctx.storage.dataDir;
  ctx.provide("persona", new PersonaService(() => dataDir));
}
