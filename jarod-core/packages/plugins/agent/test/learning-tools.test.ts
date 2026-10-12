// Portage de packages/core/test/learning-tools.test.ts (rév. 2e180305).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { learningSection } from "../src/agent.js";
import { bumpPatch, SKILL_ARCHIVE_DIR } from "@jarod/plugin-skills";
import { makeCore } from "./helpers.js";

const ctx = (sessionId = "courante") => ({ sessionId, workspace: null });

describe("skill_manage", () => {
  it("creates an agent skill, refuses to overwrite one, and notifies the user", async () => {
    const core = await makeCore();
    await core.init();
    const tool = core.tools.get("skill_manage")!;
    expect(tool.dangerous).toBe(true);

    const out = await tool.run(
      {
        action: "create",
        id: "Déployer VPS",
        name: "Déployer sur un VPS",
        description: "Quand il faut\nmettre en ligne",
        body: "1. build\n2. rsync",
      },
      ctx(),
    );
    expect(out).toContain("deployer-vps");
    const skill = core.skills.get("deployer-vps");
    expect(skill).toBeDefined();
    expect(skill!.author).toBe("agent");
    // A newline in a frontmatter value cannot forge another key.
    expect(skill!.description).toBe("Quand il faut mettre en ligne");
    expect(core.notifications.list()[0]).toMatchObject({ title: "Nouvelle skill apprise : Déployer sur un VPS" });

    await expect(
      tool.run({ action: "create", id: "revue-de-code", description: "x", body: "y" }, ctx()),
    ).rejects.toThrow(/existe déjà/);
    expect(core.skills.get("revue-de-code")!.body).toContain("Pour une revue de code");
  });

  it("updates and patches with a version bump, then archives without deleting", async () => {
    const core = await makeCore();
    await core.init();
    const tool = core.tools.get("skill_manage")!;

    await tool.run({ action: "update", id: "revue-de-code", description: "Relire du code" }, ctx());
    expect(core.skills.get("revue-de-code")).toMatchObject({ description: "Relire du code", version: "1.0.1" });

    await tool.run(
      { action: "patch", id: "revue-de-code", old_text: "bloquant, important, suggestion", new_text: "P0, P1, P2" },
      ctx(),
    );
    const patched = core.skills.get("revue-de-code")!;
    expect(patched.version).toBe("1.0.2");
    expect(patched.body).toContain("P0, P1, P2");
    expect(readFileSync(patched.path, "utf8")).toContain("name: Revue de code");

    await expect(
      tool.run({ action: "patch", id: "revue-de-code", old_text: "introuvable", new_text: "x" }, ctx()),
    ).rejects.toThrow(/introuvable/);
    await expect(tool.run({ action: "update", id: "revue-de-code" }, ctx())).rejects.toThrow(/au moins un champ/);

    await tool.run({ action: "archive", id: "revue-de-code" }, ctx());
    expect(core.skills.get("revue-de-code")).toBeUndefined();
    const archived = readdirSync(join(core.skills.dir, SKILL_ARCHIVE_DIR));
    expect(archived).toHaveLength(1);
    expect(existsSync(join(core.skills.dir, SKILL_ARCHIVE_DIR, archived[0]!, "SKILL.md"))).toBe(true);
    // The archive folder is never listed as a skill.
    await core.skills.reload();
    expect(core.skills.list().map((s) => s.id)).toEqual(["resume-document"]);
  });

  it("bumps patch versions", () => {
    expect(bumpPatch("1.2.3")).toBe("1.2.4");
    expect(bumpPatch("v2")).toBe("1.0.1");
  });
});

describe("skill supporting files", () => {
  it("lists them in load_skill and reads them only inside the skill folder", async () => {
    const core = await makeCore();
    await core.init();
    await core.skills.create("pdf", "PDF", "Lire des PDF", "Lance scripts/fill.py");
    const dir = core.skills.folder("pdf");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "fill.py"), "print('ok')");
    writeFileSync(join(dir, "logo.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(core.skills.dir, "secret.txt"), "hors skill");

    const loaded = await core.tools.get("load_skill")!.run({ id: "pdf" }, ctx());
    expect(loaded).toContain(`Dossier : ${dir}`);
    expect(loaded).toContain("- scripts/fill.py");
    expect(loaded).not.toContain("- SKILL.md");

    const read = core.tools.get("read_skill_file")!;
    expect(read.dangerous).toBeFalsy();
    expect(await read.run({ id: "pdf", path: "scripts/fill.py" }, ctx())).toBe("print('ok')");
    expect(await read.run({ id: "pdf", path: "logo.bin" }, ctx())).toMatch(/binaire/);
    await expect(read.run({ id: "pdf", path: "../secret.txt" }, ctx())).rejects.toThrow(/introuvable/);
    await expect(read.run({ id: "pdf", path: dir }, ctx())).rejects.toThrow(/introuvable/);

    // A skill without supporting files loads exactly as before.
    expect(await core.tools.get("load_skill")!.run({ id: "revue-de-code" }, ctx())).not.toContain(
      "Fichiers de la skill",
    );
  });
});

describe("session_search / session_read", () => {
  it("finds past conversations, leaves the current one out, and reads one back", async () => {
    const core = await makeCore();
    const past = core.sessions.create("Migration Postgres");
    core.messages.add(past.id, { role: "user", content: "Comment migrer la base vers Postgres ?" });
    core.messages.add(past.id, { role: "assistant", content: "On a décidé d'utiliser pgloader." });
    const current = core.sessions.create("Aujourd'hui");
    core.messages.add(current.id, { role: "user", content: "Rappelle-moi pour Postgres" });

    const found = await core.tools.get("session_search")!.run({ query: "postgres" }, ctx(current.id));
    expect(found).toContain(past.id);
    expect(found).not.toContain(current.id);

    const read = await core.tools.get("session_read")!.run({ session_id: past.id }, ctx(current.id));
    expect(read).toContain("# Migration Postgres");
    expect(read).toContain("ASSISTANT : On a décidé d'utiliser pgloader.");

    expect(await core.tools.get("session_search")!.run({ query: "kubernetes" }, ctx())).toMatch(/Aucune/);
    await expect(core.tools.get("session_read")!.run({ session_id: "nope" }, ctx())).rejects.toThrow(/introuvable/);
  });
});

describe("learning section of the system prompt", () => {
  it("only mentions the tools that are offered", () => {
    expect(learningSection({ agentMode: "build", disabledTools: [] })).toContain("skill_manage");
    expect(learningSection({ agentMode: "plan", disabledTools: [] })).not.toContain("skill_manage");
    expect(learningSection({ agentMode: "plan", disabledTools: ["session_search"] })).toBe("");
  });

  it("is part of the built system prompt", async () => {
    const core = await makeCore();
    await core.init();
    expect(core.agent.buildSystemPrompt("bonjour")).toContain("## Apprentissage");
  });
});
