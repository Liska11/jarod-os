// Outils système (phase 1, lecture seule) : `system_disk_usage`. Le parcours (équivalent de `du -d`) et la liste des emplacements protégés
// de Herald OS (`WINDOWS_PROTECTED`, permissions.py) : un chemin protégé est refusé AVANT toute lecture, par son nom puis par son chemin réel.
import { type Dir, type Dirent, realpathSync } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Emplacements dont ce module ne mesure rien : clés, jetons, magasins d'identifiants, certificats, dossiers du système et des programmes. */
export function protectedRoots(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  // Même ensemble que `contracts/v1/credential-stores.reference.json` (test de cohérence : tests/repo/credential-stores.test.ts).
  const roots = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", join(".config", "gh"), ".git-credentials", ".npmrc"].map((n) => join(home, n));
  const under = (base: string | undefined, ...rest: string[]) => {
    if (base) roots.push(join(base, ...rest));
  };
  under(env.APPDATA, "gnupg");
  under(env.APPDATA, "Microsoft", "Credentials");
  under(env.APPDATA, "Microsoft", "Protect");
  under(env.APPDATA, "Microsoft", "SystemCertificates");
  under(env.LOCALAPPDATA, "Microsoft", "Credentials");
  under(env.LOCALAPPDATA, "Microsoft", "Vault");
  under(env.PROGRAMDATA, "Microsoft", "Crypto");
  for (const v of [env.SystemRoot ?? env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData]) if (v) roots.push(v);
  return roots;
}

const norm = (p: string, win: boolean) => (win ? resolve(p).toLowerCase() : resolve(p));

const canonicalRoots = new Map<string, string>();
/**
 * Le chemin réel d'une racine protégée, mis en cache : une variable d'environnement peut l'écrire avec un nom court (8.3,
 * `C:\Users\RUNNER~1\…`) ou à travers un lien, alors que le chemin réel d'une cible (jonction suivie) est en noms longs.
 */
function canonicalRoot(root: string): string {
  let real = canonicalRoots.get(root);
  if (real === undefined) {
    try {
      real = realpathSync.native(root);
    } catch {
      real = root;
    }
    canonicalRoots.set(root, real);
  }
  return real;
}

const inside = (root: string, p: string, win: boolean) => {
  const rel = relative(norm(root, win), p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * La racine protégée qui contient `path` (ou qui l'est), ou `null`. Comparaison sans casse sous Windows, avec la racine telle
 * qu'écrite ET son chemin réel : sinon un chemin réel en noms longs passerait à côté d'une racine écrite en nom court.
 */
export function protectedRoot(path: string, roots: readonly string[], win = process.platform === "win32"): string | null {
  const p = norm(path, win);
  for (const root of roots) {
    if (inside(root, p, win) || inside(canonicalRoot(root), p, win)) return root;
  }
  return null;
}

/** `~` et `~\x` → le dossier personnel ; tout le reste tel quel. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") || path.startsWith("~\\") ? join(home, path.slice(2)) : path;
}

export interface Measure {
  total: number;
  sizes: Map<string, number>;
  timedOut: boolean;
  hadErrors: boolean;
}

/**
 * Tailles par dossier jusqu'à `depth` niveaux. Ni lien symbolique ni jonction n'est suivi (`lstat` : sous Windows, Node les rend comme des
 * liens) ; les tailles sont logiques et excluent ce qu'on n'a pas pu lire.
 */
export async function measureTree(root: string, depth: number, opts: { deadline: number; signal?: AbortSignal | undefined }): Promise<Measure> {
  const sizes = new Map<string, number>();
  const state = { timedOut: false, hadErrors: false };
  const stop = () => {
    if (opts.signal?.aborted) throw new Error("Interrompu");
    if (Date.now() > opts.deadline) {
      state.timedOut = true;
      return true;
    }
    return false;
  };

  async function visit(dir: string, level: number): Promise<number> {
    if (opts.signal?.aborted) throw new Error("Interrompu");
    let total = 0;
    let handle: Dir;
    try {
      handle = await opendir(dir);
    } catch {
      state.hadErrors = true;
      return 0;
    }
    const files: string[] = [];
    const dirs: string[] = [];
    try {
      for await (const entry of handle as AsyncIterable<Dirent>) {
        if (stop()) break;
        if (entry.isSymbolicLink()) continue;
        (entry.isDirectory() ? dirs : files).push(join(dir, entry.name));
      }
    } catch (e) {
      // Une interruption n'est pas une erreur de lecture : elle remonte.
      if (opts.signal?.aborted) throw e;
      state.hadErrors = true;
    }
    for (let i = 0; i < files.length && !state.timedOut; i += 64) {
      const batch = files.slice(i, i + 64);
      const unreadable = () => {
        state.hadErrors = true;
        return 0;
      };
      const results = await Promise.all(batch.map((f) => lstat(f).then((s) => (s.isSymbolicLink() ? 0 : s.size), unreadable)));
      for (const size of results) total += size;
      stop();
    }
    for (const sub of dirs) {
      if (stop()) break;
      // Une jonction que `readdir` aurait rendue comme un dossier : `lstat` tranche.
      try {
        if ((await lstat(sub)).isSymbolicLink()) continue;
      } catch {
        state.hadErrors = true;
        continue;
      }
      total += await visit(sub, level + 1);
    }
    if (level >= 1 && level <= depth) sizes.set(dir, total);
    return total;
  }

  const total = await visit(root, 0);
  return { total, sizes, timedOut: state.timedOut, hadErrors: state.hadErrors };
}

/** Le chemin réel (liens et jonctions résolus), ou le chemin lui-même s'il n'existe pas. */
export function realPathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}
