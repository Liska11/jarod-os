// Portage de packages/core/test/curator.test.ts (rév. 2e180305).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_ARCHIVE_DIR } from "@jarod/plugin-skills";
import { makeCore } from "./helpers.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ctx = { sessionId: "s", workspace: null };
const hooks = { emit: () => {}, approve: async () => true };

async function coreWithAgentSkill(id = "deploy-vps") {
  const core = await makeCore();
  await core.init();
  await core.skills.create(id, "Déployer", "Mettre en ligne", "1. build", { author: "agent", overwrite: false });
  return core;
}

describe("curator", () => {
  it("counts loads and patches made through the skill tools", async () => {
    const core = await coreWithAgentSkill();
    await core.tools.get("load_skill")!.run({ id: "deploy-vps" }, ctx);
    await core.tools.get("load_skill")!.run({ id: "deploy-vps" }, ctx);
    await core.tools
      .get("skill_manage")!
      .run({ action: "patch", id: "deploy-vps", old_text: "build", new_text: "pnpm build" }, ctx);
    expect(core.curator.usage("deploy-vps")).toMatchObject({ uses: 2, patches: 1, state: "active" });
  });

  it("marks unused agent skills stale, then archives them; the user's skills are never touched", async () => {
    const core = await coreWithAgentSkill();
    const t0 = core.curator.usage("deploy-vps")?.firstSeenAt ?? Date.now();
    core.curator.list(t0);

    const dry = await core.curator.run({ dryRun: true, at: t0 + 31 * DAY });
    expect(dry.archived).toEqual(["deploy-vps"]);
    expect(core.skills.get("deploy-vps")).toBeDefined();

    const stale = await core.curator.run({ at: t0 + 15 * DAY });
    expect(stale.stale).toEqual(["deploy-vps"]);
    expect(core.curator.usage("deploy-vps")?.state).toBe("stale");
    expect(core.settings.get("curator").lastRunAt).toBe(t0 + 15 * DAY);

    // A use brings it back to active.
    core.curator.recordUse("deploy-vps", t0 + 16 * DAY);
    expect(core.curator.usage("deploy-vps")?.state).toBe("active");

    const archived = await core.curator.run({ at: t0 + 47 * DAY });
    expect(archived.archived).toEqual(["deploy-vps"]);
    expect(core.skills.get("deploy-vps")).toBeUndefined();
    expect(readdirSync(join(core.skills.dir, SKILL_ARCHIVE_DIR))).toHaveLength(1);
    expect(core.notifications.list()[0]).toMatchObject({ title: "Entretien des skills" });
    // Seeded / user skills have no `author: agent`: they stay.
    expect(core.skills.get("revue-de-code")).toBeDefined();
  });

  it("protects pinned skills and skills a scheduled task names", async () => {
    const core = await coreWithAgentSkill();
    await core.skills.create("veille", "Veille", "Veille techno", "cherche", { author: "agent" });
    core.curator.setPinned("deploy-vps", true);
    core.scheduler.save({ name: "Lundi", prompt: "Utilise la skill veille", spec: { kind: "interval", minutes: 60 } });
    const r = await core.curator.run({ at: Date.now() + 60 * DAY });
    expect(r.archived).toEqual([]);
    expect(r.protected.sort()).toEqual(["deploy-vps", "veille"]);
    expect(() => core.curator.setPinned("inconnue", true)).toThrow(/introuvable/);
  });

  it("waits a full interval after the first observation, then only runs when idle", async () => {
    const core = await coreWithAgentSkill();
    const t0 = Date.now();
    expect(await core.curator.maybeRun(t0)).toBeNull();
    expect(core.settings.get("curator").lastRunAt).toBe(t0);
    expect(await core.curator.maybeRun(t0 + 24 * HOUR)).toBeNull();

    const s = core.sessions.create();
    core.sessions.touch(s.id);
    // Due, but a conversation was active less than two hours ago… from the point of view of "now".
    const justAfter = Date.now() + 30 * 60_000;
    core.settings.set("curator", { ...core.settings.get("curator"), lastRunAt: justAfter - 200 * HOUR });
    expect(await core.curator.maybeRun(justAfter)).toBeNull();
    expect(await core.curator.maybeRun(justAfter + 3 * HOUR)).not.toBeNull();

    core.settings.set("curator", { ...core.settings.get("curator"), enabled: false, lastRunAt: 1 });
    expect(await core.curator.maybeRun(Date.now() + 400 * HOUR)).toBeNull();
  });

  it("answers /curator with the usage table and runs a simulation", async () => {
    const core = await coreWithAgentSkill();
    const s = core.sessions.create();
    const status = await core.submit(s.id, "/curator", hooks);
    expect(status.kind === "command" && status.result.text).toMatch(/deploy-vps.*apprise/);
    const dry = await core.submit(s.id, "/curator dry-run", hooks);
    expect(dry.kind === "command" && dry.result.text).toBe("Rien à faire.");
    await core.submit(s.id, "/curator pin deploy-vps", hooks);
    expect(core.curator.usage("deploy-vps")?.pinned).toBe(true);
  });
});
