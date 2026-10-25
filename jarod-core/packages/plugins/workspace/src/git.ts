/**
 * Espace de travail par tâche (repris de PandaCode) : un worktree git par tâche, son diff, et le merge de sa branche
 * dans la branche courante du dépôt principal. Aucun shell : chaque commande git est lancée avec ses arguments tels quels.
 */
import { execFile } from "node:child_process";
import { childEnv } from "@jarod/kernel/child-env";
import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
/** Taille maximale du diff rendu au modèle : au-delà, le texte est coupé et signalé. */
export const DIFF_MAX_CHARS = 120_000;

export class WorkspaceError extends Error {}

/**
 * Le dépôt est celui d'un tiers, pas forcément sûr : `core.fsmonitor` fait lancer une commande de SA configuration à un simple `git status`, on
 * le coupe donc pour chaque appel. L'environnement de l'enfant est celui d'un moteur (`childEnv`) : ni jeton de contrôle interne ni clé de fournisseur
 * de Jarod, et un identifiant demandé en interactif échoue au lieu d'attendre.
 */
const GIT_SAFE_CONFIG = ["-c", "core.fsmonitor=false"];

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = childEnv("engine", { explicit: { GIT_TERMINAL_PROMPT: "0" } });
    execFile("git", [...GIT_SAFE_CONFIG, ...args], { cwd, env, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
      if (error) reject(new WorkspaceError(`git ${args[0]} : ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** Un nom de branche court et sûr : pas d'option (`-`), pas de `..`, pas de caractère d'espace ou de contrôle. */
export function checkBranchName(branch: string): string {
  const ok = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".lock");
  if (!ok) throw new WorkspaceError(`nom de branche refusé : « ${branch} »`);
  return branch;
}

async function requireRepo(repo: string): Promise<string> {
  if (!isAbsolute(repo)) throw new WorkspaceError("le chemin du dépôt doit être absolu");
  const info = await stat(repo).catch(() => null);
  if (!info?.isDirectory()) throw new WorkspaceError(`dossier introuvable : ${repo}`);
  const inside = (await git(repo, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")).trim();
  if (inside !== "true") throw new WorkspaceError(`pas un dépôt git : ${repo}`);
  return repo;
}

/** Dossier des worktrees : à côté du dépôt, `<dépôt>-worktrees/<branche>`, pour ne pas polluer le dépôt. */
export function worktreePathFor(repo: string, branch: string): string {
  return join(dirname(repo), `${basename(repo)}-worktrees`, branch.replace(/\//g, "__"));
}

export interface TaskWorktree {
  branch: string;
  path: string;
  /** Commit de départ, celui de la branche courante du dépôt au moment de la création. */
  base: string;
}

/** Crée la branche `branch` et son worktree, à partir du HEAD du dépôt principal. */
export async function createTaskWorktree(repoInput: string, branchInput: string): Promise<TaskWorktree> {
  const repo = await requireRepo(repoInput);
  const branch = checkBranchName(branchInput);
  const path = worktreePathFor(repo, branch);
  if (await stat(path).catch(() => null)) throw new WorkspaceError(`le worktree existe déjà : ${path}`);
  const base = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await mkdir(dirname(path), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
  return { branch, path, base };
}

export interface ChangedFile {
  path: string;
  /** Code de statut git à deux lettres (ex. ` M`, `A `, `??`), tel quel. */
  status: string;
}

export interface TaskDiff {
  files: ChangedFile[];
  /** Diff des fichiers suivis, par rapport à HEAD. Les fichiers non suivis n'ont pas de contenu ici, seulement une ligne dans `files`. */
  patch: string;
  truncated: boolean;
}

/** Ce qui a changé dans un worktree : fichiers (avec statut) et diff des fichiers suivis, coupé à `DIFF_MAX_CHARS`. */
export async function taskDiff(worktreeInput: string): Promise<TaskDiff> {
  const worktree = await requireRepo(worktreeInput);
  const porcelain = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = porcelain.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    const status = entry.slice(0, 2);
    files.push({ status, path: entry.slice(3) });
    // Renommage ou copie : le chemin d'origine suit comme entrée séparée, qu'on saute.
    if (status.includes("R") || status.includes("C")) i++;
  }
  const full = await git(worktree, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv"]).catch(() => "");
  const truncated = full.length > DIFF_MAX_CHARS;
  return { files, patch: truncated ? full.slice(0, DIFF_MAX_CHARS) : full, truncated };
}

export interface MergeResult {
  /** Branche courante du dépôt principal, dans laquelle la tâche a été fusionnée. */
  into: string;
  /** Nouveau commit HEAD après le merge. */
  head: string;
}

/**
 * Fusionne la branche d'une tâche dans la branche courante du dépôt principal (`--no-ff`, pour garder la trace de la tâche).
 * Refuse si le dépôt principal a des changements en cours. En cas de conflit, le merge est annulé et l'erreur le dit.
 */
export async function mergeTaskBranch(repoInput: string, branchInput: string): Promise<MergeResult> {
  const repo = await requireRepo(repoInput);
  const branch = checkBranchName(branchInput);
  const exists = (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(() => "")).trim();
  if (!exists) throw new WorkspaceError(`branche introuvable : ${branch}`);
  const dirty = (await git(repo, ["status", "--porcelain"])).trim();
  if (dirty) throw new WorkspaceError("le dépôt principal a des changements non commités ; committez ou mettez-les de côté avant le merge");
  const into = (await git(repo, ["symbolic-ref", "--short", "HEAD"]).catch(() => "")).trim();
  if (!into) throw new WorkspaceError("HEAD est détaché : impossible de savoir où fusionner");
  try {
    await git(repo, ["merge", "--no-ff", "--no-edit", branch]);
  } catch (error) {
    await git(repo, ["merge", "--abort"]).catch(() => undefined);
    throw new WorkspaceError(`conflit au merge de ${branch} dans ${into} : merge annulé. ${(error as Error).message}`);
  }
  return { into, head: (await git(repo, ["rev-parse", "HEAD"])).trim() };
}

export interface WorktreeInfo {
  path: string;
  /** Branche extraite, ou `null` pour un HEAD détaché. */
  branch: string | null;
  head: string;
  /** Le premier worktree que git liste est le dépôt principal. */
  main: boolean;
}

/** Sortie de `git worktree list --porcelain` : des blocs séparés par une ligne vide (`worktree`, `HEAD`, `branch` ou `detached`). */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const branchRef = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    list.push({
      path,
      branch: branchRef ? branchRef.replace(/^refs\/heads\//, "") : null,
      head: lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) ?? "",
      main: list.length === 0,
    });
  }
  return list;
}

export async function listWorktrees(repoInput: string): Promise<WorktreeInfo[]> {
  const repo = await requireRepo(repoInput);
  return parseWorktreeList(await git(repo, ["worktree", "list", "--porcelain"]));
}

/**
 * Forme canonique d'un chemin : liens et noms courts Windows (`RUNNER~1`) résolus. `git worktree list` rend la forme longue alors qu'un appelant peut
 * donner la forme courte ; sans cette résolution, un worktree légitime serait refusé. `null` si le chemin n'existe pas.
 */
export const canonicalPath = (p: string): string | null => {
  try {
    return realpathSync.native(resolve(p)).replace(/[\\/]+$/, "");
  } catch {
    return null;
  }
};

const samePath = (a: string, b: string): boolean => {
  const [x, y] = [canonicalPath(a), canonicalPath(b)];
  if (x === null || y === null) return false;
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * Le worktree de `repo` qui est à `path`, ou une erreur : un chemin venu de l'extérieur n'est jamais utilisé tel quel. Le `path` rendu est la forme
 * CANONIQUE validée : c'est elle qu'il faut afficher, utiliser comme dossier de travail et comme clé de toute comparaison (occupation par un agent).
 */
export async function requireWorktree(repo: string, path: string): Promise<WorktreeInfo> {
  const found = (await listWorktrees(repo)).find((w) => samePath(w.path, path));
  const real = found ? canonicalPath(found.path) : null;
  if (!found || real === null) throw new WorkspaceError(`ce dossier n'est pas un worktree de ${repo} : ${path}`);
  return { ...found, path: real };
}
