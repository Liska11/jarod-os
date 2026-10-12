// Portage de packages/core/test/extensions.test.ts:13-41 (rév. 2e180305), bloc « skills ».
import { readFileSync, writeFileSync } from "node:fs";
import { bootApp, cleanup, tempDir } from "@jarod/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "../src/index.js";
import { parseFrontmatter } from "../src/skills.js";

afterEach(cleanup);

/** `makeCore()` + `init()` → kernel avec plugin-skills (graines puis chargement au démarrage). */
async function makeCore() {
  const app = await bootApp({ storage: { dataDir: tempDir(), encryptDb: false }, skills: {} });
  return { skills: app.skills, notifications: app.storage.notifications };
}

describe("skills", () => {
  it("parses frontmatter", () => {
    expect(parseFrontmatter('---\nname: "A"\nversion: 1.2.0\n---\nCorps')).toEqual({
      meta: { name: "A", version: "1.2.0" },
      body: "Corps",
    });
    expect(parseFrontmatter("pas de frontmatter").meta).toEqual({});
  });

  it("seeds examples, toggles, and emits an update receipt on version bump", async () => {
    const core = await makeCore();
    expect(core.skills.list().map((s) => s.id)).toEqual(["resume-document", "revue-de-code"]);
    core.skills.setEnabled("revue-de-code", false);
    expect(core.skills.promptSection()).not.toContain("revue-de-code");

    const path = core.skills.get("resume-document")!.path;
    writeFileSync(path, readFileSync(path, "utf8").replace("version: 1.0.0", "version: 1.1.0"));
    await core.skills.reload();
    expect(core.notifications.list()[0]).toMatchObject({
      title: "Skill mise à jour : Résumé de document",
      body: "Version 1.0.0 → 1.1.0",
    });
    expect(core.skills.get("revue-de-code")!.enabled).toBe(false);

    const created = await core.skills.create("Ma Skill!", "Ma skill", "desc", "fais ceci");
    expect(created.id).toBe("ma-skill");
  });
});
