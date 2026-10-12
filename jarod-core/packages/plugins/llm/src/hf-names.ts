/**
 * Validation des noms de dépôt et de fichier Hugging Face (SPECS-P5-MODELS.md § 3.9 (b) et § 5). Un nom vient d'un renderer ou d'une réponse d'API : une
 * entrée non fiable. Il est validé AVANT toute requête et toute écriture ; un nom refusé ne produit ni requête, ni octet, ni dossier.
 *
 * Fonctions pures, hors `resolveUnder` / `ensureDirUnder` qui touchent le disque (confinement du chemin RÉEL, liens et jonctions compris).
 */
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type HfNameErrorCode = "INVALID_REPO" | "INVALID_FILE" | "UNSUPPORTED_FILE" | "PATH_ESCAPES";

export class HfNameError extends Error {
  constructor(
    readonly code: HfNameErrorCode,
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = "HfNameError";
  }
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SEGMENT = /^[A-Za-z0-9._()+\- ]{1,128}$/;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;
export const HF_FILE_MAX_LENGTH = 240;

/** `null` quand l'identifiant `propriétaire/dépôt` est valide, sinon la raison du refus. */
export function repoIdProblem(repo: unknown): string | null {
  if (typeof repo !== "string") return "l'identifiant du dépôt n'est pas une chaîne";
  if (!REPO.test(repo)) return "format « propriétaire/dépôt » attendu : lettres, chiffres, « . _ - », commençant par une lettre ou un chiffre, 96 caractères au plus par partie";
  if (repo.includes("..")) return "« .. » est refusé dans un identifiant de dépôt";
  // Durcissement du 2026-10-03 : Windows retire le point final d'un nom de dossier (`<owner>__<repo>.` et `<owner>__<repo>` seraient le même dossier).
  if (repo.split("/").some((part) => part.endsWith("."))) return "le propriétaire et le nom du dépôt ne finissent pas par un point (Windows le retire : deux dépôts désigneraient le même dossier)";
  return null;
}

export function validateRepoId(repo: unknown): string {
  const problem = repoIdProblem(repo);
  if (problem) throw new HfNameError("INVALID_REPO", problem);
  return repo as string;
}

/** `null` quand le nom de fichier (chemin relatif à `/`) est acceptable ; sinon le code et la raison. */
export function fileNameProblem(file: unknown): { code: "INVALID_FILE" | "UNSUPPORTED_FILE"; reason: string } | null {
  const invalid = (reason: string) => ({ code: "INVALID_FILE" as const, reason });
  if (typeof file !== "string") return invalid("le nom de fichier n'est pas une chaîne");
  if (file.length === 0) return invalid("nom de fichier vide");
  if (file.length > HF_FILE_MAX_LENGTH) return invalid(`nom de fichier de plus de ${HF_FILE_MAX_LENGTH} caractères`);
  const segments = file.split("/");
  for (const seg of segments) {
    if (seg.length === 0) return invalid("segment vide (chemin absolu, « // » ou « / » final)");
    if (!SEGMENT.test(seg)) return invalid(`segment « ${printable(seg)} » : seuls les lettres, chiffres et « . _ ( ) + - » (espace compris) sont admis, 128 caractères au plus`);
    if (seg === "." || seg === "..") return invalid(`segment « ${seg} » refusé`);
    if (seg.startsWith(" ") || seg.endsWith(" ") || seg.endsWith(".")) {
      return invalid(`segment « ${printable(seg)} » : ni espace en tête, ni espace ou point en fin (Windows les retire : deux noms désigneraient le même fichier)`);
    }
    if (RESERVED.test(seg.split(".")[0]!.trimEnd().toUpperCase())) return invalid(`segment « ${seg} » : nom réservé de Windows`);
  }
  const last = segments[segments.length - 1]!;
  if (!last.toLowerCase().endsWith(".gguf")) return { code: "UNSUPPORTED_FILE", reason: `${file} n'est pas un fichier .gguf` };
  if (last.length === ".gguf".length) return invalid("nom sans radical (« .gguf » seul)");
  return null;
}

function printable(s: string): string {
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** Valide le nom et rend ses segments ; lève `HfNameError` sinon. */
export function validateFileName(file: unknown): { path: string; segments: string[] } {
  const problem = fileNameProblem(file);
  if (problem) throw new HfNameError(problem.code, problem.reason);
  return { path: file as string, segments: (file as string).split("/") };
}

/** `owner/repo` encodé segment par segment pour une adresse (le dépôt doit déjà être valide). */
export function encodeRepoPath(repo: string): string {
  return validateRepoId(repo).split("/").map(encodeURIComponent).join("/");
}

export function encodeFilePath(file: string): string {
  return validateFileName(file).segments.map(encodeURIComponent).join("/");
}

function escapes(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Refuse un chemin qui sort de `root` ou qui le désigne lui-même (comparaison lexicale, après normalisation). */
export function assertInside(root: string, candidate: string): void {
  if (escapes(resolve(root), resolve(candidate))) {
    throw new HfNameError("PATH_ESCAPES", `le chemin ${candidate} sort du dossier de destination ${root}`);
  }
}

/** Nom validé, puis chemin résolu sous `destDir` : rend le chemin absolu de la cible. Ne touche pas au disque. */
export function resolveUnder(destDir: string, file: unknown): string {
  const { segments } = validateFileName(file);
  const root = resolve(destDir);
  const target = resolve(root, ...segments);
  assertInside(root, target);
  return target;
}

/**
 * Crée les dossiers de `target` sous `root` après avoir vérifié le chemin RÉEL de leur ancêtre existant le plus profond : un lien ou une jonction placé dans
 * la destination qui mène dehors est refusé AVANT de créer quoi que ce soit.
 */
export function ensureDirUnder(root: string, target: string): void {
  assertInside(root, target);
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);
  const parent = dirname(resolve(target));
  let probe = parent;
  while (!exists(probe)) probe = dirname(probe);
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    throw new HfNameError("PATH_ESCAPES", `le chemin ${probe} n'a pas pu être résolu (lien rompu)`);
  }
  if (realProbe !== realRoot && escapes(realRoot, realProbe)) {
    throw new HfNameError("PATH_ESCAPES", `le dossier ${probe} mène hors de la destination (lien ou jonction)`);
  }
  mkdirSync(parent, { recursive: true });
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
