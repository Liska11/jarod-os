/**
 * Démarrage/arrêt du kernel. Un plugin qui échoue à démarrer fait échouer `start` (jamais d'échec
 * silencieux) ; `stop` libère dans l'ordre inverse du chargement — les effets (`ctx.effect`)
 * ferment timers et base, comme `core.ts:1760-1780` (`dispose`).
 */
import type { Fiber, Plugin } from "cordis";
import type { JarodApp } from "./app.js";
import { discoverPlugins, loadPlugin, type PluginEntry } from "./registry.js";

export interface Started {
  loaded: PluginEntry[];
  fibers: Fiber[];
}

const FIBER_ACTIVE = 2;
const FIBER_FAILED = 3;

type Inject = string[] | Record<string, { required?: boolean } | null | undefined>;

/** Services d'un plugin : son nom (convention `ctx.<nom>`) + le champ cordis standard `provide`. */
function providedBy(entry: PluginEntry, plugin: Plugin): string[] {
  const extra = (plugin as { provide?: string | string[] }).provide;
  return [entry.name, ...(extra === undefined ? [] : Array.isArray(extra) ? extra : [extra])];
}

/**
 * cordis rc.10 attend CHAQUE clé de `inject` (`Fiber._refresh`) : `{ required: false }` n'y change
 * rien. Une dépendance optionnelle qu'aucun plugin activé ne fournit est donc retirée de `inject`
 * (le plugin lit alors `ctx.get(nom)` → undefined) ; fournie par un plugin activé, elle reste
 * attendue (et son échec fait échouer le démarrage — jamais d'échec silencieux).
 */
function withoutAbsentOptionals(plugin: Plugin, provided: Set<string>): Plugin {
  const inject = (plugin as { inject?: Inject }).inject;
  if (!inject || Array.isArray(inject)) return plugin;
  const absent = Object.keys(inject).filter((k) => inject[k]?.required === false && !provided.has(k));
  if (!absent.length) return plugin;
  const kept = Object.fromEntries(Object.entries(inject).filter(([k]) => !absent.includes(k)));
  if (typeof plugin !== "function") return { ...plugin, inject: kept } as Plugin;
  // Classe (Service) : sous-classe ; fonction : enveloppe. Nom, Config et provide suivent.
  const fn = plugin as unknown as (...a: unknown[]) => unknown;
  const derived: Plugin = /^class\b/.test(Function.prototype.toString.call(fn))
    ? (class extends (fn as unknown as new (...a: unknown[]) => object) {} as unknown as Plugin)
    : (((ctx: unknown, config: unknown) => fn(ctx, config)) as unknown as Plugin);
  for (const key of ["name", "Config", "provide"] as const) {
    const value = (plugin as unknown as Record<string, unknown>)[key];
    if (value !== undefined) Object.defineProperty(derived, key, { value, configurable: true });
  }
  Object.defineProperty(derived, "inject", { value: kept, configurable: true });
  return derived;
}

export async function start(app: JarodApp): Promise<Started> {
  const { plugins, pluginsDir } = app.jarodConfig;
  const loaded: PluginEntry[] = [];
  const fibers: Fiber[] = [];
  const enabled: { entry: PluginEntry; plugin: Plugin; section: unknown }[] = [];
  for (const entry of discoverPlugins(pluginsDir)) {
    const section = plugins[entry.name];
    if (section === false) continue;
    if (section === undefined) continue;
    enabled.push({ entry, plugin: await loadPlugin(entry), section });
  }
  const provided = new Set(enabled.flatMap(({ entry, plugin }) => providedBy(entry, plugin)));
  for (const { entry, plugin, section } of enabled) {
    fibers.push(app.plugin(withoutAbsentOptionals(plugin, provided) as never, section as never));
    loaded.push(entry);
  }
  const errors = new Map<Fiber, unknown>();
  // Une fibre peut repartir APRÈS son `await()` : un service optionnel publié plus tard (vision,
  // mcp pour plugin-agent) la recharge, et ses dépendants avec (plugin-gateways injecte `agent`).
  // On attend donc que plus aucune fibre ne soit en (dé)chargement avant de juger leur état.
  do {
    await Promise.all(fibers.map((f) => f.await().catch((e: unknown) => void errors.set(f, e))));
  } while (fibers.some((f) => (f as unknown as { inertia?: Promise<void> }).inertia));
  const failed = fibers.filter((f) => f.state !== FIBER_ACTIVE);
  if (failed.length) {
    await stop({ loaded, fibers });
    // `await()` ne rejette pas toujours (selon l'ordre de résolution) : l'erreur reste sur la fibre.
    const errorOf = (f: Fiber) => errors.get(f) ?? (f as unknown as { _error?: unknown })._error;
    const first = failed.map(errorOf).find((e) => e instanceof Error);
    // L'erreur d'origine remonte telle quelle (message et type) : « clé introuvable » doit rester lisible.
    // Un seul plugin en échec : ceux qui n'attendent que ses services (ex. gateways → agent) n'ajoutent rien.
    const hard = failed.filter((f) => f.state === FIBER_FAILED || errorOf(f) !== undefined);
    if (first instanceof Error && hard.length === 1) throw first;
    const names = failed.map((f) => `${f.name}(${f.state === FIBER_FAILED ? "échec" : "en attente de dépendances"})`);
    throw new Error(`Plugins non démarrés : ${names.join(", ")}`, { cause: first });
  }
  app.emit("kernel:ready" as never);
  return { loaded, fibers };
}

export async function stop(started: Started): Promise<void> {
  for (const f of [...started.fibers].reverse()) await f.dispose();
}
