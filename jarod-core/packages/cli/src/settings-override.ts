// Réglages surchargés EN MÉMOIRE pour une exécution de la CLI (jamais écrits dans la base partagée) : `ask` et `acp`.
import type { Settings } from "@jarod/contracts";
import type { CliCore } from "./context.js";

export function overrideSettings(core: CliCore, overrides: Partial<Settings>): void {
  const getAll = core.settings.getAll.bind(core.settings);
  const get = core.settings.get.bind(core.settings);
  core.settings.getAll = () => ({ ...getAll(), ...overrides });
  core.settings.get = ((key: keyof Settings) => (key in overrides ? overrides[key] : get(key))) as typeof core.settings.get;
}
