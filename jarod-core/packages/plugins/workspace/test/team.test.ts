/**
 * Équipe : un worktree par worker, workers en parallèle, échecs isolés, et refus des équipes invalides.
 * Les agents sont le faux agent (fixtures/fake-agent.mjs) ; les dépôts sont de vrais dépôts git temporaires.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Launch } from "../src/cli-agent.js";
import { git, taskDiff } from "../src/git.js";
import { runTeam } from "../src/team.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jarod-team-"));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["config", "user.email", "test@example.invalid"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await writeFile(join(repo, "app.txt"), "v1\n");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

/** Un agent factice par mode : `claude-ok` réussit, `exit2` échoue. */
const launchWith = (modes: Record<string, string>) => (harness: "claude" | "codex") => ({
  command: process.execPath,
  args: [FAKE, modes[harness] ?? "claude-ok"],
}) as Launch;

describe("runTeam", () => {
  it("crée un worktree par worker, lance chacun et rend son résultat", async () => {
    const repo = await makeRepo();
    const workers = await runTeam(
      repo,
      [
        { branch: "feature/a", harness: "claude", prompt: "tâche A" },
        { branch: "feature/b", harness: "claude", prompt: "tâche B" },
      ],
      { launch: launchWith({}) },
    );
    expect(workers.map((w) => [w.branch, w.ok, w.text])).toEqual([
      ["feature/a", true, "reçu: tâche A"],
      ["feature/b", true, "reçu: tâche B"],
    ]);
    for (const w of workers) await expect(stat(w.path)).resolves.toBeDefined();
  });

  it("un worker en échec n'arrête pas les autres", async () => {
    const repo = await makeRepo();
    const workers = await runTeam(
      repo,
      [
        { branch: "ok-task", harness: "claude", prompt: "bon" },
        { branch: "ko-task", harness: "codex", prompt: "mauvais" },
      ],
      { launch: launchWith({ codex: "exit2" }) },
    );
    expect(workers[0]).toMatchObject({ ok: true });
    expect(workers[1]).toMatchObject({ ok: false, error: "code de sortie 2" });
  });

  it("compte les fichiers modifiés par chaque worker dans son worktree", async () => {
    const repo = await makeRepo();
    // Le faux agent ne modifie rien : on vérifie seulement que le compte passe bien par le worktree, qui est propre.
    const [worker] = await runTeam(repo, [{ branch: "solo", harness: "claude", prompt: "rien" }], { launch: launchWith({}) });
    expect(worker?.changedFiles).toBe((await taskDiff(worker!.path)).files.length);
    expect(worker?.changedFiles).toBe(0);
  });

  it("refuse une équipe vide, trop grande, ou avec deux fois la même branche", async () => {
    const repo = await makeRepo();
    const task = (branch: string) => ({ branch, harness: "claude" as const, prompt: "x" });
    await expect(runTeam(repo, [])).rejects.toThrow(/de 1 à 3/);
    await expect(runTeam(repo, [task("a"), task("b"), task("c"), task("d")])).rejects.toThrow(/de 1 à 3/);
    await expect(runTeam(repo, [task("a"), task("a")])).rejects.toThrow(/partager une branche/);
  });

  it("refuse un modèle invalide avant de créer le moindre worktree", async () => {
    const repo = await makeRepo();
    await expect(
      runTeam(repo, [
        { branch: "premier", harness: "claude", prompt: "x" },
        { branch: "second", harness: "claude", prompt: "y", model: "a b" },
      ]),
    ).rejects.toThrow(/modèle refusé/);
    await expect(stat(join(repo, "..", "repo-worktrees", "premier"))).rejects.toThrow();
  });
});
