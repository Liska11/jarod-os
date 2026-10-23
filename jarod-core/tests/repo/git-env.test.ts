// Non-régression de l'incident du 2026-10-22 : des variables GIT_* héritées, pointées sur un autre dépôt, détournaient `git init` / `git commit`
// d'un dépôt temporaire vers ce dépôt. La « victime » ici est elle-même un dépôt temporaire : le vrai dépôt n'est jamais visé.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_VAR, isolatedGitEnv, stripGitEnv } from "./git-env.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8" }).trim();

/** Un dépôt victime avec un commit, et l'environnement empoisonné qui le vise depuis ailleurs (montage du banc fautif). */
function poisoned() {
  const clean = isolatedGitEnv();
  const victim = temp("jarod-gitenv-victim-");
  git(victim, clean, "init", "-q");
  writeFileSync(join(victim, "a.txt"), "a\n");
  git(victim, clean, "add", "-A");
  git(victim, clean, "commit", "-q", "-m", "victime");
  const other = temp("jarod-gitenv-tree-");
  const env = { ...clean, GIT_DIR: join(victim, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, "index") };
  const snapshot = () => ({
    head: git(victim, clean, "rev-parse", "HEAD"),
    config: readFileSync(join(victim, ".git", "config"), "utf8"),
    reflog: git(victim, clean, "reflog", "--format=%H"),
  });
  return { victim, env, snapshot };
}

describe("isolement Git des tests (incident du 2026-10-22)", () => {
  it("le montage fautif est bien dangereux : sans isolement, git init réinitialise la victime et y écrit core.worktree", () => {
    const { victim, env } = poisoned();
    const d = temp("jarod-gitenv-repo-");
    git(d, env, "init", "-q");
    expect(readFileSync(join(victim, ".git", "config"), "utf8")).toMatch(/worktree\s*=/);
  });

  it("avec isolatedGitEnv, init + add + commit restent dans le dépôt temporaire ; la victime ne change pas", () => {
    const { env, snapshot } = poisoned();
    const before = snapshot();
    const d = temp("jarod-gitenv-repo-");
    const safe = isolatedGitEnv(env);
    git(d, safe, "init", "-q");
    writeFileSync(join(d, "b.txt"), "b\n");
    git(d, safe, "add", "-A");
    git(d, safe, "commit", "-q", "-m", "init");
    expect(snapshot()).toEqual(before);
    expect(git(d, safe, "log", "--format=%s")).toBe("init");
  });

  it("toute variable GIT_* est retirée, quelle que soit la casse ; les autres restent", () => {
    const env: NodeJS.ProcessEnv = { GIT_DIR: "x", Git_Work_Tree: "y", git_index_file: "z", GIT_CONFIG_GLOBAL: "c", PATH: "p", JAROD_X: "1" };
    expect(isolatedGitEnv(env)).toEqual({ PATH: "p", JAROD_X: "1" });
    expect(env.GIT_DIR).toBe("x"); // isolatedGitEnv copie, ne modifie pas
    expect(stripGitEnv(env).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_DIR", "Git_Work_Tree", "git_index_file"]);
    expect(env).toEqual({ PATH: "p", JAROD_X: "1" });
  });

  it("le fichier de préparation a vidé l'environnement de ce processus de toute variable GIT_*", () => {
    expect(Object.keys(process.env).filter((k) => GIT_VAR.test(k))).toEqual([]);
  });

  it("un dépôt fabriqué dans un sous-dossier d'un autre dépôt ne remonte pas vers lui", () => {
    const { victim, snapshot } = poisoned();
    const before = snapshot();
    const nested = join(victim, "sub");
    mkdirSync(nested);
    const env = isolatedGitEnv();
    git(nested, env, "init", "-q");
    writeFileSync(join(nested, "c.txt"), "c\n");
    git(nested, env, "add", "-A");
    git(nested, env, "commit", "-q", "-m", "imbriqué");
    // Chemin réel : sur la CI Windows, le dossier temporaire est un nom court (RUNNER~1) que git développe.
    expect(git(nested, env, "rev-parse", "--show-toplevel").replace(/\\/g, "/").toLowerCase()).toBe(realpathSync.native(nested).replace(/\\/g, "/").toLowerCase());
    expect(snapshot()).toEqual(before);
  });
});
