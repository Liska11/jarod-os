// Outils système, phase 3 : la PLANIFICATION des opérations sur les fichiers (mkdir, move, copy, trash). Pur côté arguments, lecture seule côté disque.
// L'essai à blanc (`system_files_plan`) et l'application (`system_files`) passent par ce même code : le plan montré EST le plan appliqué. Pour cela
// la planification simule ce que les opérations précédentes d'un lot auront fait (un dossier créé par la première opération existe pour la
// deuxième), au lieu de regarder seulement le disque tel qu'il est maintenant. Repris de `plan_operations` de Herald OS (MIT, licenses/HERALD-OS.md),
// avec deux ajouts : la simulation, et le refus d'un chemin qui CONTIENT un emplacement protégé (déplacer le dossier personnel emporterait `.ssh`).
import { realpathSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { expandHome, protectedRoot } from "./disk.js";

export type OpName = "mkdir" | "move" | "copy" | "trash";

export interface FileOp {
  op: OpName;
  path: string;
  /** Pour move et copy : la destination RÉSOLUE (le dossier de destination déjà complété du nom de la source). */
  to?: string;
}

const OPS: readonly OpName[] = ["mkdir", "move", "copy", "trash"];
export const MAX_OPERATIONS = 200;

export function describeOp(o: FileOp): string {
  if (o.op === "mkdir") return `créer le dossier ${o.path}`;
  if (o.op === "move") return `déplacer ${o.path} → ${o.to ?? "?"}`;
  if (o.op === "copy") return `copier ${o.path} → ${o.to ?? "?"}`;
  return `mettre à la corbeille ${o.path}`;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Les arguments de l'outil → la liste ordonnée des opérations demandées (destinations pas encore résolues). Lève si c'est mal formé. */
export function requestedOperations(args: Record<string, unknown>, home: string): FileOp[] {
  const action = text(args.action);
  const abs = (raw: unknown, what: string): string => {
    const p = text(raw);
    if (!p) throw new Error(`${what} est requis`);
    const full = expandHome(p, home);
    if (!isAbsolute(full)) throw new Error(`Chemin non absolu : ${p}. Donner un chemin complet ou ~.`);
    return resolve(full);
  };
  const ops: FileOp[] = [];
  if (action === "batch") {
    if (!Array.isArray(args.operations) || args.operations.length === 0) throw new Error("operations (liste non vide) est requis pour batch");
    if (args.operations.length > MAX_OPERATIONS) throw new Error(`Trop d'opérations (${args.operations.length}, au plus ${MAX_OPERATIONS}).`);
    for (const raw of args.operations) {
      if (!raw || typeof raw !== "object") throw new Error(`Opération invalide : ${JSON.stringify(raw)}`);
      const r = raw as Record<string, unknown>;
      const op = text(r.op) as OpName;
      if (!OPS.includes(op)) throw new Error(`Opération inconnue : ${JSON.stringify(r.op)} (mkdir, move, copy, trash)`);
      ops.push(op === "move" || op === "copy" ? { op, path: abs(r.path, "path"), to: abs(r.to, `to (pour ${op})`) } : { op, path: abs(r.path, "path") });
    }
  } else if (action === "mkdir") ops.push({ op: "mkdir", path: abs(args.path, "path") });
  else if (action === "move" || action === "copy") ops.push({ op: action, path: abs(args.path, "path"), to: abs(args.to, `to (pour ${action})`) });
  else if (action === "trash") {
    const raws = Array.isArray(args.paths) && args.paths.length > 0 ? args.paths : args.path ? [args.path] : [];
    if (raws.length === 0) throw new Error("paths (ou path) est requis pour trash");
    if (raws.length > MAX_OPERATIONS) throw new Error(`Trop d'éléments (${raws.length}, au plus ${MAX_OPERATIONS}).`);
    for (const p of raws) ops.push({ op: "trash", path: abs(p, "path") });
  } else throw new Error(`action doit être l'un de : mkdir, move, copy, trash, batch`);
  return ops;
}

const key = (p: string, win: boolean) => (win ? resolve(p).toLowerCase() : resolve(p));

/** `inner` est `outer` ou se trouve dedans. */
export function isInside(outer: string, inner: string, win = process.platform === "win32"): boolean {
  const rel = relative(key(outer, win), key(inner, win));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Le chemin réel du plus proche ancêtre qui existe, complété du reste : pour juger un chemin qui n'existe pas encore (une destination). */
export async function realOfNearest(path: string): Promise<string> {
  const rest: string[] = [];
  let cur = resolve(path);
  for (;;) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(path);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/** `realOfNearest`, synchrone : pour `targetsOf`, que la porte appelle sans attendre. */
export function realOfNearestSync(path: string): string {
  const rest: string[] = [];
  let cur = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(path);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/**
 * Autonomie configurable : TOUTES les cibles d'un appel de `system_files` (chaque source, chaque destination finale), en chemins RÉELS — une
 * jonction placée dans un dossier autorisé ne fait pas sortir l'autorisation de ce dossier. Une destination qui est un dossier existant reçoit
 * le nom de la source (comme le plan). Lève si les arguments sont mal formés (cibles inconnues : une autorisation par dossier ne joue pas).
 */
export function operationTargets(args: Record<string, unknown>, home: string): string[] {
  const out: string[] = [];
  for (const o of requestedOperations(args, home)) {
    out.push(realOfNearestSync(o.path));
    if (o.to !== undefined) {
      let to = o.to;
      try {
        if (statSync(to).isDirectory()) to = join(to, basename(o.path));
      } catch {
        // destination absente : c'est le nouveau chemin complet
      }
      out.push(realOfNearestSync(to));
    }
  }
  return out;
}

/** Pourquoi cet emplacement est hors limites, ou `null`. Vérifié par le nom puis par le chemin réel ; refuse aussi ce qui CONTIENT un emplacement protégé. */
export async function forbiddenReason(path: string, roots: readonly string[], win = process.platform === "win32"): Promise<string | null> {
  const real = await realOfNearest(path);
  const hit = protectedRoot(path, roots, win) ?? protectedRoot(real, roots, win);
  if (hit) return `${path} est dans l'emplacement protégé ${hit}`;
  if (parse(resolve(path)).root === resolve(path)) return `${path} est la racine d'un disque`;
  const inside = roots.find((r) => isInside(path, r, win) || isInside(real, r, win));
  if (inside) return `${path} contient l'emplacement protégé ${inside}`;
  return null;
}

interface Node {
  exists: boolean;
  isDir: boolean;
}

/** Le disque tel qu'il sera après les opérations déjà planifiées : par-dessus le vrai disque, ce qui a été créé, déplacé ou retiré. */
class Overlay {
  private readonly added = new Map<string, boolean>();
  private readonly removed = new Set<string>();
  constructor(private readonly win: boolean) {}

  async stat(p: string): Promise<Node> {
    const k = key(p, this.win);
    if (this.removed.has(k)) return { exists: false, isDir: false };
    const isDir = this.added.get(k);
    if (isDir !== undefined) return { exists: true, isDir };
    try {
      const s = await lstat(p);
      return { exists: true, isDir: s.isDirectory() };
    } catch {
      return { exists: false, isDir: false };
    }
  }
  add(p: string, isDir: boolean) {
    const k = key(p, this.win);
    this.removed.delete(k);
    this.added.set(k, isDir);
  }
  remove(p: string) {
    const k = key(p, this.win);
    this.added.delete(k);
    this.removed.add(k);
  }
}

export interface Plan {
  ops: FileOp[];
  descriptions: string[];
  /** Ce qui empêche d'appliquer le plan tel quel : rien n'est modifié tant que la liste n'est pas vide. */
  problems: string[];
  tier: "mutate" | "destructive";
}

/**
 * Le plan complet : destinations résolues, problèmes listés. Ne modifie rien. Les emplacements protégés sont des problèmes (donc détectés dès
 * l'essai à blanc) et `system_files` les refuse avant toute demande d'accord.
 */
export async function planFiles(args: Record<string, unknown>, roots: readonly string[], home: string, win = process.platform === "win32"): Promise<Plan> {
  const requested = requestedOperations(args, home);
  const overlay = new Overlay(win);
  const ops: FileOp[] = [];
  const problems: string[] = [];
  const bad = new Set<string>();
  const forbid = async (p: string) => {
    if (bad.has(p)) return;
    const why = await forbiddenReason(p, roots, win);
    if (why) {
      bad.add(p);
      problems.push(why);
    }
  };
  for (const r of requested) {
    await forbid(r.path);
    if (r.op === "mkdir") {
      const n = await overlay.stat(r.path);
      if (n.exists && !n.isDir) problems.push(`${r.path} existe et n'est pas un dossier`);
      overlay.add(r.path, true);
      ops.push(r);
      continue;
    }
    const src = await overlay.stat(r.path);
    if (!src.exists) problems.push(`${r.path} n'existe pas`);
    if (r.op === "trash") {
      overlay.remove(r.path);
      ops.push(r);
      continue;
    }
    // move / copy : si la destination est un dossier, la source y entre sous son nom ; sinon la destination est le nouveau nom complet.
    const dest = await overlay.stat(r.to!);
    const target = dest.exists && dest.isDir ? join(r.to!, basename(r.path)) : r.to!;
    await forbid(target);
    if ((await overlay.stat(target)).exists) problems.push(`${target} existe déjà : rien n'est écrasé`);
    if (src.isDir && isInside(r.path, target, win)) problems.push(`${r.path} ne peut pas être placé dans lui-même (${target})`);
    ops.push({ op: r.op, path: r.path, to: target });
    if (r.op === "move") overlay.remove(r.path);
    overlay.add(target, src.isDir);
  }
  return {
    ops,
    descriptions: ops.map(describeOp),
    problems: [...new Set(problems)],
    tier: ops.some((o) => o.op === "trash") ? "destructive" : "mutate",
  };
}
