import { JarodConfig as JarodConfigSchema, type JarodConfig } from "@jarod/contracts";
import { Context } from "cordis";

/**
 * Racine du kernel (PLAN §1). Services exposés en `ctx.<nom>` par les plugins (`ctx.storage`,
 * `ctx.scheduler`, `ctx.jobs`…). Aucune dépendance `@one-ai/*` / `@kama/*`.
 */
export class JarodApp extends Context {
  readonly jarodConfig: ReturnType<typeof JarodConfigSchema.parse>;

  constructor(config: JarodConfig = {}) {
    super();
    this.jarodConfig = JarodConfigSchema.parse(config);
  }
}
