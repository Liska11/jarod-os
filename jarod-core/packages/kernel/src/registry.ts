/**
 * Découverte des plugins LOCAUX (PLAN §1 : « plus de tarballs »). Un plugin est un package de
 * `packages/plugins/*` dont le `package.json` porte `"jarod": { "plugin": "<nom>", "order": n }`.
 * Remplace le câblage manuel `core.ts:343-635` : l'ordre de démarrage réel vient de `inject`,
 * `order` ne sert qu'à rendre le chargement déterministe.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "cordis";

export interface PluginEntry {
  /** Nom court (`storage`, `scheduler`…) : clé de sa section dans `JarodConfig.plugins`. */
  name: string;
  /** Nom du package (`@jarod/plugin-storage`). */
  pkg: string;
  order: number;
  /** Fichier d'entrée résolu (`exports["."]`). */
  entry: string;
}

/** `packages/plugins` du dépôt, vu depuis `packages/kernel/src`. */
export const DEFAULT_PLUGINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../plugins");

export function discoverPlugins(dir = DEFAULT_PLUGINS_DIR): PluginEntry[] {
  if (!existsSync(dir)) return [];
  const found: PluginEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const manifest = join(dir, d.name, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      name: string;
      exports?: string | Record<string, string>;
      jarod?: { plugin?: string; order?: number };
    };
    if (!pkg.jarod?.plugin) continue;
    const exp = typeof pkg.exports === "string" ? pkg.exports : (pkg.exports?.["."] ?? "./src/index.ts");
    found.push({ name: pkg.jarod.plugin, pkg: pkg.name, order: pkg.jarod.order ?? 100, entry: join(dir, d.name, exp) });
  }
  return found.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Charge le module d'un plugin : export `default`, sinon le module lui-même (forme `apply`). */
export async function loadPlugin(entry: PluginEntry): Promise<Plugin> {
  const mod = (await import(pathToFileURL(entry.entry).href)) as { default?: Plugin } & Plugin;
  return (mod.default ?? mod) as Plugin;
}
