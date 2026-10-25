/**
 * Espace de code : les canaux `codespace-*` sur de vrais dépôts git temporaires. La garde de dossiers et la confirmation native sont des
 * doublures : ce qui est testé, c'est ce que le handler exige d'elles avant d'agir.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, runCliAgent } from "@jarod/plugin-workspace";
import { afterEach, describe, expect, it } from "vitest";
import type { FileGate } from "../src/main/file-gate.js";
import { createCodespaceHandlers, PROMPT_PREVIEW_CHARS } from "../src/main/handlers/codespace.js";
import type { HandlerContext } from "../src/main/handlers/context.js";
import { JAROD_INVOKE_CHANNELS } from "@jarod/contracts/ipc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jarod-codespace-"));
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

/** Des handlers dont la garde accepte tout dossier (ou refuse, si `denied`) et dont la boîte native répond `answer`. */
function setup(options: { answer?: boolean; denied?: string; noDialog?: boolean } = {}) {
  const asked: string[] = [];
  const details: string[] = [];
  const gate = {
    bindable: (_channel: string, path: unknown) => {
      if (options.denied) throw new Error(options.denied);
      return String(path);
    },
  } as unknown as FileGate;
  const ctx = {
    shell: options.noDialog
      ? {}
      : {
          confirm: async (title: string, detail?: string) => {
            asked.push(title);
            details.push(detail ?? "");
            return options.answer ?? true;
          },
        },
  } as unknown as HandlerContext;
  return { h: createCodespaceHandlers(ctx, gate), asked, details };
}

describe("déclaration des canaux", () => {
  it("chaque canal servi est déclaré dans JAROD_INVOKE_CHANNELS, et inversement", () => {
    const served = Object.keys(setup().h).sort();
    expect(served).toEqual(JAROD_INVOKE_CHANNELS.filter((c) => c.startsWith("codespace-")).sort());
  });
});

describe("agents et worktrees", () => {
  it("liste les deux agents, avec leur chemin s'ils sont installés", () => {
    const agents = setup().h["codespace-agents"]();
    expect(agents.map((a) => [a.id, a.name])).toEqual([
      ["claude", "Claude Code"],
      ["codex", "Codex CLI"],
    ]);
    for (const a of agents) expect(a.path === null || typeof a.path === "string").toBe(true);
  });

  it("crée un worktree après confirmation, et le liste", async () => {
    const repo = await makeRepo();
    const { h, asked } = setup();
    const created = await h["codespace-create-worktree"](repo, "feature/ui");
    expect(created).toMatchObject({ branch: "feature/ui" });
    expect(asked).toEqual(["Créer un worktree ?"]);
    const list = await h["codespace-worktrees"](repo);
    expect(list.map((w) => w.branch)).toEqual(["main", "feature/ui"]);
  });

  it("sans accord de l'utilisateur, rien n'est créé", async () => {
    const repo = await makeRepo();
    const { h } = setup({ answer: false });
    expect(await h["codespace-create-worktree"](repo, "feature/non")).toBeNull();
    expect(await h["codespace-worktrees"](repo)).toHaveLength(1);
  });

  it("sans boîte native (mode sans fenêtre), refuse au lieu d'agir", async () => {
    const repo = await makeRepo();
    const { h } = setup({ noDialog: true });
    await expect(h["codespace-create-worktree"](repo, "feature/x")).rejects.toThrow(/confirmation native indisponible/);
  });

  it("un dossier refusé par la garde n'est jamais ouvert", async () => {
    const repo = await makeRepo();
    const { h } = setup({ denied: "dossier non choisi" });
    await expect(h["codespace-worktrees"](repo)).rejects.toThrow(/dossier non choisi/);
    await expect(h["codespace-diff"](repo, repo)).rejects.toThrow(/dossier non choisi/);
  });
});

describe("diff et merge", () => {
  it("rend le diff d'un worktree listé, et refuse un chemin qui n'en est pas un", async () => {
    const repo = await makeRepo();
    const { h } = setup();
    const task = (await h["codespace-create-worktree"](repo, "feature/diff"))!;
    await writeFile(join(task.path, "app.txt"), "v2\n");

    const diff = await h["codespace-diff"](repo, task.path);
    expect(diff.files).toEqual([{ status: " M", path: "app.txt" }]);
    expect(diff.patch).toContain("+v2");

    await expect(h["codespace-diff"](repo, join(repo, "..", ".."))).rejects.toThrow(/n'est pas un worktree/);
  });

  it("fusionne la tâche dans la branche courante après confirmation", async () => {
    const repo = await makeRepo();
    const { h, asked } = setup();
    const task = (await h["codespace-create-worktree"](repo, "feature/merge"))!;
    await writeFile(join(task.path, "neuf.txt"), "fait\n");
    await git(task.path, ["add", "neuf.txt"]);
    await git(task.path, ["commit", "-m", "tâche"]);

    expect(await h["codespace-merge"](repo, "feature/merge")).toMatchObject({ into: "main" });
    expect(asked).toContain("Fusionner la tâche ?");
    expect(await readFile(join(repo, "neuf.txt"), "utf8")).toBe("fait\n");
  });

  it("refuser la confirmation du merge laisse le dépôt intact", async () => {
    const repo = await makeRepo();
    const accept = setup().h;
    const task = (await accept["codespace-create-worktree"](repo, "feature/refus"))!;
    await writeFile(join(task.path, "neuf.txt"), "x\n");
    await git(task.path, ["add", "neuf.txt"]);
    await git(task.path, ["commit", "-m", "tâche"]);

    expect(await setup({ answer: false }).h["codespace-merge"](repo, "feature/refus")).toBeNull();
    await expect(stat(join(repo, "neuf.txt"))).rejects.toThrow();
  });
});

describe("agent de code", () => {
  it("refuse un agent inconnu, le dépôt principal, et un chemin qui n'est pas un worktree", async () => {
    const repo = await makeRepo();
    const { h } = setup();
    const task = (await h["codespace-create-worktree"](repo, "feature/agent"))!;
    await expect(h["codespace-run-agent"](repo, task.path, "vim", "fais")).rejects.toThrow(/agent inconnu/);
    await expect(h["codespace-run-agent"](repo, repo, "claude", "fais")).rejects.toThrow(/pas dans le dépôt principal/);
    await expect(h["codespace-run-agent"](repo, join(repo, ".."), "claude", "fais")).rejects.toThrow(/n'est pas un worktree/);
  });

  it("sans accord, l'agent n'est pas lancé", async () => {
    const repo = await makeRepo();
    const task = (await setup().h["codespace-create-worktree"](repo, "feature/agent2"))!;
    const { h, asked } = setup({ answer: false });
    expect(await h["codespace-run-agent"](repo, task.path, "codex", "fais quelque chose")).toBeNull();
    expect(asked).toEqual(["Lancer Codex CLI ?"]);
  });
});

describe("GitHub", () => {
  it("refuse un genre inconnu et un numéro absent avant d'appeler gh", async () => {
    const repo = await makeRepo();
    const { h } = setup();
    await expect(h["codespace-github-list"](repo, "wikis")).rejects.toThrow(/genre inconnu/);
    await expect(h["codespace-github-pr"](repo, "12")).rejects.toThrow(/numéro de PR manquant/);
  });
});

describe("confirmation du lancement d'un agent", () => {
  it("montre la tâche, le modèle et le dossier : on approuve ce qui sera réellement envoyé", async () => {
    const repo = await makeRepo();
    const task = (await setup().h["codespace-create-worktree"](repo, "feature/conf"))!;
    const { h, details } = setup({ answer: false });

    expect(await h["codespace-run-agent"](repo, task.path, "claude", "corrige le bug de connexion", "opus-5")).toBeNull();

    // git écrit les chemins avec des « / », même sous Windows.
    expect(details[0]!.replaceAll("\\", "/")).toContain(task.path.replaceAll("\\", "/"));
    expect(details[0]).toContain("Modèle : opus-5");
    expect(details[0]).toContain("Tâche envoyée (27 caractères) :\ncorrige le bug de connexion");
    expect(details[0]).not.toContain("tronquée");
  });

  it("tronque une tâche longue à la limite, en disant sa longueur totale", async () => {
    const repo = await makeRepo();
    const task = (await setup().h["codespace-create-worktree"](repo, "feature/long"))!;
    const { h, details } = setup({ answer: false });
    const long = "a".repeat(PROMPT_PREVIEW_CHARS + 500);

    await h["codespace-run-agent"](repo, task.path, "codex", long);

    expect(details[0]).toContain(`(${long.length} caractères)`);
    expect(details[0]).toContain("a".repeat(PROMPT_PREVIEW_CHARS));
    expect(details[0]).not.toContain("a".repeat(PROMPT_PREVIEW_CHARS + 1));
    expect(details[0]).toContain("[… tronquée]");
    expect(details[0]).toContain("Modèle : celui de l'agent");
  });

  it("refuse un nom de modèle invalide AVANT d'ouvrir la boîte", async () => {
    const repo = await makeRepo();
    const task = (await setup().h["codespace-create-worktree"](repo, "feature/modele"))!;
    const { h, asked } = setup();

    await expect(h["codespace-run-agent"](repo, task.path, "claude", "fais", "x; rm -rf /")).rejects.toThrow(/modèle refusé/);
    expect(asked).toEqual([]);
  });

  it("refuse AVANT la boîte quand un agent travaille déjà dans ce worktree", async () => {
    const repo = await makeRepo();
    const task = (await setup().h["codespace-create-worktree"](repo, "feature/occupe"))!;
    const dir = await mkdtemp(join(tmpdir(), "jarod-hang-"));
    roots.push(dir);
    const script = join(dir, "hang.mjs");
    await writeFile(script, "setTimeout(() => {}, 60000);");
    const controller = new AbortController();
    const running = runCliAgent({ harness: "claude", cwd: task.path, prompt: "long", signal: controller.signal }, { command: process.execPath, args: [script] });
    try {
      const { h, asked } = setup();
      await expect(h["codespace-run-agent"](repo, task.path, "claude", "autre tâche")).rejects.toThrow(/travaille déjà/);
      expect(asked).toEqual([]);
    } finally {
      controller.abort();
      await running;
    }
  });
});
