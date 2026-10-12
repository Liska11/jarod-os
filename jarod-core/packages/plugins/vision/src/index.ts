/**
 * @jarod/plugin-vision — `ctx.vision` : description d'images pour les modèles aveugles.
 * Câblage `core.ts:462-467`. obs/media-control : Phase 3.
 */
import type {} from "@jarod/plugin-llm";
import type {} from "@jarod/plugin-rag";
import type {} from "@jarod/plugin-storage";
import type { Context } from "cordis";
import { ImageDescriber } from "./vision.js";

export * from "./vision.js";

declare module "cordis" {
  interface Context {
    vision: ImageDescriber;
  }
}

export const name = "vision";
export const inject = ["storage", "llm", "rag"];

export function apply(ctx: Context): void {
  ctx.provide(
    "vision",
    new ImageDescriber({
      db: ctx.storage.db,
      settings: ctx.storage.settings,
      providers: ctx.llm.providers,
      attachments: ctx.rag.attachments,
    }),
  );
}
