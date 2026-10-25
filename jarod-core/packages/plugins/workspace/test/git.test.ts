/**
 * Worktrees par tâche sur de vrais dépôts git temporaires : création, diff, merge, refus et conflit.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBranchName, createTaskWorktree, git, mergeTaskBranch, taskDiff, worktreePathFor } from "../src/git.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Dépôt avec une branche `main` et un commit initial contenant `app.txt`. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jarod-ws-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  // Pas de conversion de fins de ligne (Windows) : les fichiers de test restent exactement ce qu'on écrit.
  await git(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repo, "app.txt"), "v1\n");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("noms de branche", () => {
  it("accepte les noms courants et refuse les options, les espaces et les séquences dangereuses", () => {
    expect(checkBranchName("feature/login-2")).toBe("feature/login-2");
    for (const bad of ["-delete", "a..b", "a b", "x/", "x.lock", "", "a;rm"]) {
      expect(() => checkBranchName(bad), bad).toThrow();
    }
  });

  it("place le worktree à côté du dépôt, sans slash dans le nom du dossier", () => {
    expect(worktreePathFor("/work/app", "feature/login")).toBe(join("/work", "app-worktrees", "feature__login"));
  });
});

describe("worktree de tâche", () => {
  it("crée une branche et un worktree, puis le diff voit les changements suivis et non suivis", async () => {
    const repo = await makeRepo();
    const task = await createTaskWorktree(repo, "feature/login");
    expect(task.branch).toBe("feature/login");
    expect(await readFile(join(task.path, "app.txt"), "utf8")).toBe("v1\n");

    await writeFile(join(task.path, "app.txt"), "v2\n");
    await writeFile(join(task.path, "neuf.txt"), "nouveau\n");
    const diff = await taskDiff(task.path);
    expect(diff.files).toEqual(
      expect.arrayContaining([
        { status: " M", path: "app.txt" },
        { status: "??", path: "neuf.txt" },
      ]),
    );
    expect(diff.patch).toContain("-v1");
    expect(diff.patch).toContain("+v2");
    expect(diff.truncated).toBe(false);
  });

  it("refuse de recréer un worktree qui existe déjà", async () => {
    const repo = await makeRepo();
    await createTaskWorktree(repo, "t1");
    await expect(createTaskWorktree(repo, "t1")).rejects.toThrow(/existe déjà|already/);
  });

  it("un worktree sans changement a un diff vide", async () => {
    const repo = await makeRepo();
    const task = await createTaskWorktree(repo, "t2");
    expect(await taskDiff(task.path)).toEqual({ files: [], patch: "", truncated: false });
  });
});

describe("merge de la branche d'une tâche", () => {
  it("fusionne la tâche dans la branche courante avec un commit de merge", async () => {
    const repo = await makeRepo();
    const task = await createTaskWorktree(repo, "feature/x");
    await writeFile(join(task.path, "feature.txt"), "fait\n");
    await git(task.path, ["add", "feature.txt"]);
    await git(task.path, ["commit", "-m", "feature"]);

    const merged = await mergeTaskBranch(repo, "feature/x");
    expect(merged.into).toBe("main");
    expect(await readFile(join(repo, "feature.txt"), "utf8")).toBe("fait\n");
    const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(" ");
    expect(parents).toHaveLength(3); // HEAD + 2 parents : c'est bien un --no-ff
  });

  it("refuse si le dépôt principal a des changements non commités", async () => {
    const repo = await makeRepo();
    await createTaskWorktree(repo, "feature/y");
    await writeFile(join(repo, "app.txt"), "modifié à la main\n");
    await expect(mergeTaskBranch(repo, "feature/y")).rejects.toThrow(/non commités/);
  });

  it("refuse une branche inconnue", async () => {
    const repo = await makeRepo();
    await expect(mergeTaskBranch(repo, "absente")).rejects.toThrow(/introuvable/);
  });

  it("en cas de conflit, annule le merge et laisse le dépôt propre", async () => {
    const repo = await makeRepo();
    const task = await createTaskWorktree(repo, "feature/c");
    await writeFile(join(task.path, "app.txt"), "côté tâche\n");
    await git(task.path, ["commit", "-am", "tâche"]);
    await writeFile(join(repo, "app.txt"), "côté principal\n");
    await git(repo, ["commit", "-am", "principal"]);

    await expect(mergeTaskBranch(repo, "feature/c")).rejects.toThrow(/conflit/);
    expect((await git(repo, ["status", "--porcelain"])).trim()).toBe("");
    expect(await readFile(join(repo, "app.txt"), "utf8")).toBe("côté principal\n");
  });
});

describe("liste des worktrees", () => {
  it("lit la sortie porcelain de git : le principal d'abord, branche ou HEAD détaché", async () => {
    const parsed = (await import("../src/git.js")).parseWorktreeList(
      [
        "worktree C:/work/app",
        "HEAD aaa111",
        "branch refs/heads/main",
        "",
        "worktree C:/work/app-worktrees/feature__x",
        "HEAD bbb222",
        "branch refs/heads/feature/x",
        "",
        "worktree C:/work/app-worktrees/detache",
        "HEAD ccc333",
        "detached",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { path: "C:/work/app", branch: "main", head: "aaa111", main: true },
      { path: "C:/work/app-worktrees/feature__x", branch: "feature/x", head: "bbb222", main: false },
      { path: "C:/work/app-worktrees/detache", branch: null, head: "ccc333", main: false },
    ]);
  });

  it("voit le worktree créé, et refuse un dossier qui n'en est pas un", async () => {
    const { listWorktrees, requireWorktree } = await import("../src/git.js");
    const repo = await makeRepo();
    const task = await createTaskWorktree(repo, "feature/liste");
    const all = await listWorktrees(repo);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ main: true, branch: "main" });
    expect(all[1]).toMatchObject({ main: false, branch: "feature/liste" });
    await expect(requireWorktree(repo, task.path)).resolves.toMatchObject({ branch: "feature/liste" });
    await expect(requireWorktree(repo, join(repo, ".."))).rejects.toThrow(/n'est pas un worktree/);
  });
});

describe("dépôt d'un tiers", () => {
  it("n'exécute pas la commande core.fsmonitor de la configuration du dépôt", async () => {
    const repo = await makeRepo();
    const marker = join(repo, "..", "fsmonitor-ran.txt");
    const script = join(repo, "..", "fsmonitor.mjs");
    await writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x"); process.stdout.write("\\0");`);
    const hook = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`;
    await git(repo, ["config", "core.fsmonitor", hook]);

    // Contrôle : sans la protection, un simple `git status` lance bien la commande — sinon ce test ne prouverait rien.
    execFileSync("git", ["status"], { cwd: repo, stdio: "ignore" });
    const control = await stat(marker).then(() => true, () => false);
    expect(control, "le contrôle doit déclencher la commande").toBe(true);
    await rm(marker);

    await taskDiff(repo);
    await git(repo, ["status"]);
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
  });
});
