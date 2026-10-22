/**
 * Isolement Git des tests (incident du 2026-10-22) : un banc de validation lançait ces gardes avec `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`
 * pointés sur le VRAI dépôt ; `git init` + `git commit` d'un dépôt temporaire ont alors réinitialisé le vrai dépôt (`core.worktree`) et commité
 * sur sa branche. Git suit ces variables avant le `cwd` : un test qui fabrique un dépôt ne doit en hériter aucune.
 */

/** Toute variable `GIT_*`, quelle que soit la casse (sous Windows `Git_Dir` vaut `GIT_DIR`). */
export const GIT_VAR = /^GIT_/i;

/** Copie de l'environnement sans aucune variable `GIT_*` : à passer en `env` de chaque appel git d'un test. */
export function isolatedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !GIT_VAR.test(k)));
}

/** Retire les variables `GIT_*` de `env` (par défaut l'environnement du processus) ; rend les noms retirés. */
export function stripGitEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = Object.keys(env).filter((k) => GIT_VAR.test(k));
  for (const k of names) delete env[k];
  return names;
}
