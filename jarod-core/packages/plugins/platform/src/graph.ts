/**
 * Graphe de dépendances : plages de versions, ordre d'activation (dépendances d'abord), cycles et manques
 * signalés avec le chemin exact, et « qui dépend de moi » pour refuser un retrait ou une désactivation qui
 * casserait un autre plugin.
 */
import type { PluginManifest } from "./manifest.js";

export class GraphError extends Error {}

type V = [number, number, number];
const parse = (v: string): V => v.split(".").map(Number) as V;
const cmp = (a: V, b: V): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** `^1.2.3` : même majeure (0.x : même mineure), au moins 1.2.3. `~1.2.3` : même mineure. `>=` : au moins. Nu : exact. */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  const op = /^(\^|~|>=)/.exec(range)?.[1] ?? "";
  const base = parse(range.slice(op.length));
  if (cmp(v, base) < 0) return false;
  if (op === ">=") return true;
  if (op === "~") return v[0] === base[0] && v[1] === base[1];
  if (op === "^") return base[0] === 0 ? v[0] === 0 && v[1] === base[1] : v[0] === base[0];
  return cmp(v, base) === 0;
}

/** Ordre d'activation de `roots` (et de tout ce dont ils dépendent), dépendances d'abord. */
export function activationOrder(available: ReadonlyMap<string, PluginManifest>, roots: string[]): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string, wanted?: { by: string; range: string }) => {
    const m = available.get(name);
    if (!m) throw new GraphError(`${wanted ? `${wanted.by} dépend de ` : ""}${name} : introuvable`);
    if (wanted && !satisfies(m.version, wanted.range)) {
      throw new GraphError(`${wanted.by} demande ${name} ${wanted.range}, mais ${m.version} est présent`);
    }
    if (stack.includes(name)) throw new GraphError(`cycle : ${[...stack.slice(stack.indexOf(name)), name].join(" → ")}`);
    if (done.has(name)) return;
    stack.push(name);
    for (const [dep, range] of Object.entries(m.dependencies).sort(([a], [b]) => a.localeCompare(b))) visit(dep, { by: name, range });
    stack.pop();
    done.add(name);
    order.push(name);
  };
  for (const r of [...roots].sort()) visit(r);
  return order;
}

/** Les plugins de `among` qui dépendent, directement ou non, de `name`. */
export function dependents(available: ReadonlyMap<string, PluginManifest>, among: Iterable<string>, name: string): string[] {
  const set = new Set(among);
  const out = new Set<string>();
  const walk = (target: string) => {
    for (const other of set) {
      const m = available.get(other);
      if (m && target in m.dependencies && !out.has(other)) {
        out.add(other);
        walk(other);
      }
    }
  };
  walk(name);
  return [...out].sort();
}
