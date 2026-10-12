/**
 * @jarod/plugin-memory — `ctx.memory` : mémoire (FTS), profil utilisateur, portabilité.
 * Câblage `core.ts:356,379,380,455-461`. curator (construit par plugin-agent : il lit l'activité des tours), goals : Q1.
 */
import { join } from "node:path";
import type {} from "@jarod/plugin-storage";
import { type Context, Service } from "cordis";
import { AnnotationService } from "./annotations.js";
import { MemoryService } from "./memory.js";
import { PortabilityService } from "./portability.js";
import { UserProfileService } from "./user-profile.js";

export * from "./annotations.js";
export * from "./curator.js";
export * from "./memory.js";
export * from "./portability.js";
export * from "./user-profile.js";

declare module "cordis" {
  interface Context {
    memory: MemoryPluginService;
  }
}

export class MemoryPluginService extends Service {
  static readonly inject = ["storage"];
  readonly memory: MemoryService;
  readonly userProfile: UserProfileService;
  readonly portability: PortabilityService;
  readonly annotations: AnnotationService;

  constructor(ctx: Context) {
    super(ctx, "memory");
    const { db, dataDir, settings, events } = ctx.storage;
    this.memory = new MemoryService(db);
    this.annotations = new AnnotationService({ db, events });
    this.userProfile = new UserProfileService(() => dataDir);
    this.portability = new PortabilityService({
      memory: this.memory,
      settings,
      // Le coeur ne connait qu'un dossier de profil : c'est le processus principal qui tient la liste.
      profileDir: () => dataDir,
      dir: () => join(dataDir, "exports"),
    });
  }
}

export default MemoryPluginService;
export * from "./references.js";
